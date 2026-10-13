/**
 * Tenant isolation harness (FR-001, PLAN §9.1 item 6, §16 "Tenant isolation suite").
 *
 * Every tenant service registers isolation cases in a `<feature>.isolation.ts` file next to it:
 *
 * ```ts
 * // packages/core/src/areas/areas.isolation.ts
 * export const renameAreaIsolation = defineIsolationCases(renameArea, {
 *   // Runs once per tenant inside withTenant(tenant.operatorId): create what the service acts on.
 *   seed: async ({ tx, tenant }) => {
 *     const id = uuidv7();
 *     await tx.insert(areas).values({ id, operatorId: tenant.operatorId, name: "North" });
 *     return { areaId: id };
 *   },
 *   cases: [
 *     // Called with the *victim's* seed for the attack, and the attacker's own for the control.
 *     { name: "rename another tenant's area", input: (s) => ({ areaId: s.areaId, name: "X" }) },
 *   ],
 * });
 * ```
 *
 * For each case `checkIsolationCase` seeds two fresh tenants (attacker A, victim B) and, for every
 * role allowed the capability (or `roles`):
 * - `expect: "not_found"` (default): calls the service as A with B's ids and requires
 *   **NOT_FOUND**, an error that mentions none of B's ids, and **no change anywhere in the
 *   database**; then, as a control, calls it with A's own ids and requires success (`control:
 *   "ok"`, default) or at least not NOT_FOUND (`"not_not_found"`), which proves the case really
 *   exercises the lookup;
 * - `expect: "no_leak"` (lists, searches, reports: inputs without ids): calls the service as B
 *   first (warms any cache), then as A, and requires success, none of B's ids in A's output, at
 *   least one of A's ids in it (control) and no change to B's rows.
 *
 * `src/testing/isolation.test.ts` discovers every `*.isolation.ts` and runs all cases;
 * `src/testing/coverage.test.ts` fails if any service lacks cases.
 */
import type { Tx } from "@cb/db";
import type { TestDatabase } from "@cb/db/testing";
import { rolesFor, type TenantRole } from "../authz/capabilities";
import { createServiceRuntime, type ServiceRuntime } from "../context/runtime";
import type { AnyService, ServiceInput } from "../context/service";
import { createLogger } from "../logging/logger";
import { changedTables, databaseFingerprint } from "./fingerprint";
import { contextFor, type SeededTenant, seedTenant } from "./fixtures";

const CASE_SET_MARK = Symbol.for("@cb/core/isolation-case-set");

export interface IsolationSeedArgs {
  /** A `withTenant(tenant.operatorId)` transaction. */
  readonly tx: Tx;
  readonly tenant: SeededTenant;
}

export type IsolationExpectation = "not_found" | "no_leak";

export interface IsolationCase<In, Seed> {
  readonly name: string;
  /** Default `not_found`. */
  readonly expect?: IsolationExpectation;
  /** The service input. Gets the victim's seed for the attack and the attacker's for the control. */
  readonly input: (seed: Seed, tenant: SeededTenant) => In;
  /** Roles to attack as. Default: every role allowed the service's capability. */
  readonly roles?: readonly TenantRole[];
  /** `not_found` cases: what the call with the attacker's own ids must give. Default `ok`. */
  readonly control?: "ok" | "not_not_found";
}

export interface IsolationCaseSet {
  readonly [CASE_SET_MARK]: true;
  readonly service: AnyService;
  /** Set when the service is exempt (with the reason); then there are no cases. */
  readonly exempt?: string;
  readonly seed: (args: IsolationSeedArgs) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: cases are typed by defineIsolationCases.
  readonly cases: readonly IsolationCase<any, any>[];
}

export function isIsolationCaseSet(value: unknown): value is IsolationCaseSet {
  return typeof value === "object" && value !== null && CASE_SET_MARK in value;
}

/** Registers isolation cases for `service`. Export the result from a `*.isolation.ts` file. */
export function defineIsolationCases<S extends AnyService, Seed>(
  service: S,
  spec: {
    readonly seed: (args: IsolationSeedArgs) => Promise<Seed>;
    readonly cases: readonly IsolationCase<ServiceInput<S>, Seed>[];
  },
): IsolationCaseSet {
  return Object.freeze({
    [CASE_SET_MARK]: true as const,
    service,
    seed: spec.seed,
    cases: spec.cases,
  });
}

/**
 * Declares that `service` needs no isolation cases, with a reason a reviewer can check (e.g. it
 * reads nothing tenant-specific). Use sparingly: the coverage test requires a real reason.
 */
export function exemptFromIsolation(service: AnyService, reason: string): IsolationCaseSet {
  return Object.freeze({
    [CASE_SET_MARK]: true as const,
    service,
    exempt: reason,
    seed: async () => undefined,
    cases: [],
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every UUID inside a JSON-like value (lower-cased). */
export function collectUuids(value: unknown): Set<string> {
  const text = JSON.stringify(value ?? null, (_k, v) => (typeof v === "bigint" ? `${v}` : v));
  return new Set((text.match(UUID) ?? []).map((id) => id.toLowerCase()));
}

function idsOf(tenant: SeededTenant, seed: unknown): Set<string> {
  const ids = collectUuids(seed);
  ids.add(tenant.operatorId.toLowerCase());
  for (const id of Object.values(tenant.users)) ids.add(id.toLowerCase());
  ids.add(tenant.deviceId.toLowerCase());
  return ids;
}

function mentioned(value: unknown, ids: Set<string>): string[] {
  const found = collectUuids(value);
  return [...ids].filter((id) => found.has(id));
}

function harnessRuntime(database: Pick<TestDatabase, "db">): ServiceRuntime {
  // Strict logger: a service that logs PII fails its isolation case too.
  return createServiceRuntime({ db: database.db, logger: createLogger({ sink: () => {} }) });
}

/**
 * Runs one isolation case against a test database and returns the violations (empty = isolated).
 * Seeds two fresh tenants, so cases don't affect each other.
 */
export async function checkIsolationCase(
  database: Pick<TestDatabase, "db" | "admin">,
  set: IsolationCaseSet,
  testCase: IsolationCase<unknown, unknown>,
): Promise<string[]> {
  const violations: string[] = [];
  const { service } = set;
  const runtime = harnessRuntime(database);
  const attacker = await seedTenant(database);
  const victim = await seedTenant(database);
  const attackerSeed = await database.db.withTenant(attacker.operatorId, (tx) =>
    set.seed({ tx, tenant: attacker }),
  );
  const victimSeed = await database.db.withTenant(victim.operatorId, (tx) =>
    set.seed({ tx, tenant: victim }),
  );
  const victimIds = idsOf(victim, victimSeed);
  const attackerSeedIds = collectUuids(attackerSeed);
  const allowed = rolesFor(service.capability);
  const roles = testCase.roles ?? allowed;
  const expectation = testCase.expect ?? "not_found";

  for (const role of roles) {
    const tag = `[${role}]`;
    if (!allowed.includes(role)) {
      violations.push(`${tag} role is not allowed ${service.capability}; fix the case's roles`);
      continue;
    }
    const attackerCtx = await contextFor(runtime, attacker, role);

    if (expectation === "not_found") {
      const before = await databaseFingerprint(database);
      const result = await service.call(runtime, attackerCtx, testCase.input(victimSeed, victim));
      if (result.ok) {
        violations.push(`${tag} expected NOT_FOUND for the other tenant's ids, got ok`);
        const leaked = mentioned(result.value, victimIds);
        if (leaked.length > 0) violations.push(`${tag} output contains the other tenant's ids`);
      } else {
        if (result.error.code !== "NOT_FOUND") {
          violations.push(`${tag} expected NOT_FOUND, got ${result.error.code}`);
        }
        if (mentioned(result.error, victimIds).length > 0) {
          violations.push(`${tag} the error mentions the other tenant's ids`);
        }
      }
      const changed = changedTables(before, await databaseFingerprint(database));
      if (changed.length > 0) {
        violations.push(`${tag} the database changed: ${changed.join(", ")}`);
      }
    } else {
      const victimCtx = await contextFor(runtime, victim, role);
      await service.call(runtime, victimCtx, testCase.input(victimSeed, victim));
      const before = await databaseFingerprint(database, { operatorId: victim.operatorId });
      const result = await service.call(
        runtime,
        attackerCtx,
        testCase.input(attackerSeed, attacker),
      );
      if (!result.ok) {
        violations.push(`${tag} expected ok for the tenant's own query, got ${result.error.code}`);
      } else {
        if (mentioned(result.value, victimIds).length > 0) {
          violations.push(`${tag} output contains the other tenant's ids`);
        }
        if (attackerSeedIds.size > 0 && mentioned(result.value, attackerSeedIds).length === 0) {
          violations.push(
            `${tag} control failed: the tenant's own seeded rows are not in the output`,
          );
        }
      }
      const changed = changedTables(
        before,
        await databaseFingerprint(database, { operatorId: victim.operatorId }),
      );
      if (changed.length > 0) {
        violations.push(`${tag} the other tenant's rows changed: ${changed.join(", ")}`);
      }
    }
  }

  if (expectation === "not_found" && roles.length > 0) {
    const firstRole = roles.find((r) => allowed.includes(r));
    if (firstRole) {
      const ctx = await contextFor(runtime, attacker, firstRole);
      const control = await service.call(runtime, ctx, testCase.input(attackerSeed, attacker));
      const wanted = testCase.control ?? "ok";
      if (wanted === "ok" && !control.ok) {
        violations.push(
          `control failed: with the tenant's own ids the call gave ${control.error.code}, not ok`,
        );
      } else if (!control.ok && control.error.code === "NOT_FOUND") {
        violations.push("control failed: the tenant's own ids also give NOT_FOUND");
      }
    }
  }
  return violations;
}
