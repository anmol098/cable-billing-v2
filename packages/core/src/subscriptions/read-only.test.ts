/**
 * Read-only mode end to end (D-13, PLAN §9.4, §13; T-085 acceptance): for **every** exported
 * service that writes (found by discovery, called with its own isolation case's valid input), a
 * tenant in `read_only` or `cancelled` gets TENANT_READ_ONLY unless the capability is on the
 * allowlist (collections: payments, receipts, handover submit; paying the subscription). The same
 * call in a normal tenant never gets TENANT_READ_ONLY (control). A new write service is covered
 * automatically, because every service must register isolation cases.
 *
 * The phone's payment sync through the real route handler is covered in apps/web
 * (`api/cron/subscription-states/read-only.test.ts`).
 */
import type { SubscriptionStatus } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it } from "vitest";
import type { Capability } from "../authz/capabilities";
import { capabilitySpec, rolesFor } from "../authz/capabilities";
import { discoverIsolationCaseSets } from "../testing/discovery";
import { contextFor, seedTenant, testRuntime } from "../testing/fixtures";

/** D-13 / PLAN §9.4, written out by hand (not read from the code under test). */
const ALLOWED_WHILE_READ_ONLY: readonly Capability[] = [
  "payments.record",
  "receipts.share",
  "handover.submit",
  "subscription.manage",
];

describeDb("read-only mode across every write service", () => {
  const t = useTestDatabase();

  it("blocks every write outside the allowlist and lets the allowlist through", async () => {
    const sets = (await discoverIsolationCaseSets()).filter(
      ({ set }) => !set.exempt && set.cases.length > 0,
    );
    const writes = sets.filter(
      ({ set }) => capabilitySpec(set.service.capability).kind === "write",
    );
    expect(writes.length).toBeGreaterThan(15);
    const runtime = testRuntime(t.current.db);
    const rows: string[] = [];
    const problems: string[] = [];

    for (const { set } of writes) {
      const service = set.service;
      const allowed = ALLOWED_WHILE_READ_ONLY.includes(service.capability);
      const testCase = set.cases[0];
      if (!testCase) continue;
      for (const role of rolesFor(service.capability)) {
        for (const status of ["read_only", "cancelled", "active"] as SubscriptionStatus[]) {
          const tenant = await seedTenant(t.current, { subscription: status });
          const seed = await t.current.db.withTenant(tenant.operatorId, (tx) =>
            set.seed({ tx, tenant }),
          );
          const ctx = await contextFor(runtime, tenant, role);
          const result = await service.call(runtime, ctx, testCase.input(seed, tenant));
          const code = result.ok ? "ok" : result.error.code;
          const blocked = code === "TENANT_READ_ONLY";
          const shouldBlock = status !== "active" && !allowed;
          rows.push(`${service.name} ${role} ${status} → ${code}`);
          if (blocked !== shouldBlock) {
            problems.push(
              `${service.name} (${service.capability}) as ${role} in ${status}: got ${code}, expected ${
                shouldBlock ? "TENANT_READ_ONLY" : "not TENANT_READ_ONLY"
              }`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
    // The collection path is really exercised (not just absent from the discovered set).
    expect(rows.some((r) => r.startsWith("payments.") && r.includes("lineman read_only"))).toBe(
      true,
    );
    expect(
      rows.some((r) => r.includes("billing.start_run owner read_only → TENANT_READ_ONLY")),
    ).toBe(true);
  }, 600_000);
});
