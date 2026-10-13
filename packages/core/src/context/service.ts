/**
 * `defineService`: the one way to write a tenant service (PLAN §3 "every write is a transaction
 * with a tenant context", §9).
 *
 * ```ts
 * export const renameArea = defineService({
 *   name: "areas.rename",
 *   capability: "business_profile.manage",
 *   input: z.object({ areaId: z.uuid(), name: z.string().trim().min(1).max(60) }),
 *   async run({ input, tx, audit }) {
 *     const [before] = await tx.select().from(areas).where(eq(areas.id, input.areaId));
 *     if (!before) return err(notFound());
 *     const [after] = await tx.update(areas).set({ name: input.name })
 *       .where(eq(areas.id, input.areaId)).returning();
 *     await audit.record({ entityType: "area", entityId: input.areaId,
 *       before: { name: before.name }, after: { name: after.name } });
 *     return ok({ id: after.id, name: after.name });
 *   },
 * });
 *
 * const result = await renameArea.call(runtime, ctx, { areaId, name });
 * ```
 *
 * What `call` does, in order:
 * 1. refuses a context not issued by `resolveTenantContext` (throws: a programming error);
 * 2. **role**: `can(ctx.role, capability)` or FORBIDDEN (before looking at the input, so a caller
 *    without the capability learns nothing about it);
 * 3. **validate**: `input.safeParse` or VALIDATION (field paths + issue codes, never values);
 * 4. **transaction**: `db.withTenant(ctx.operatorId, …)`: RLS limits every statement to the tenant;
 *    `read` capabilities that are not audited run READ ONLY;
 * 5. **writable**: `assertWritable` inside that transaction or TENANT_READ_ONLY (D-13);
 * 6. **run**; an `err` result **rolls the transaction back** (nothing a failed call wrote stays);
 * 7. **audit**: an audited capability must have recorded an event (same transaction) or skipped;
 * 8. **errors**: thrown errors are mapped (`toServiceError`): another tenant's id → NOT_FOUND,
 *    unique → CONFLICT, anything unexpected → INTERNAL (logged with safe fields only);
 * 9. **log**: one `service.completed` / `service.failed` line with request_id, operator_id,
 *    user_id, service, capability, duration_ms and the error code.
 */
import type { Tx, TxOptions } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import type { z } from "zod";
import { type AuditRecorder, createAuditRecorder } from "../audit/audit";
import { assertRole } from "../authz/assert-role";
import { type Capability, capabilitySpec, isCapability } from "../authz/capabilities";
import { assertWritable } from "../authz/writable";
import {
  type CoreErrorCode,
  isExpectedError,
  type ServiceError,
  toServiceError,
  validationError,
} from "../errors/errors";
import { errorLogFields, type Logger, PiiInLogError } from "../logging/logger";
import type { ServiceRuntime } from "./runtime";
import { assertIssuedTenantContext, type TenantContext } from "./tenant-context";

/** What `run` receives. */
export interface ServiceArgs<I> {
  readonly ctx: TenantContext;
  /** The validated (parsed) input. */
  readonly input: I;
  /** The tenant transaction. Never let it escape `run`. */
  readonly tx: Tx;
  readonly audit: AuditRecorder;
  /** Logger with request_id, operator_id, user_id and service already set. No PII. */
  readonly log: Logger;
  /** The time of this call (from the runtime clock). Use it instead of `new Date()`. */
  readonly now: Date;
}

export interface ServiceDefinition<S extends z.ZodType, T, C extends string> {
  /** Dotted snake_case, unique across core (`areas.rename`). Default audit action, log field. */
  readonly name: string;
  readonly capability: Capability;
  /** Zod schema for the input. Validation failures never reach `run`. */
  readonly input: S;
  /** e.g. `serializable` for a billing run. Default: Postgres' READ COMMITTED. */
  readonly isolationLevel?: TxOptions["isolationLevel"];
  run(args: ServiceArgs<z.output<S>>): Promise<Result<T, ServiceError<C>>>;
}

const SERVICE_MARK = Symbol.for("@cb/core/service");

export interface Service<In = unknown, T = unknown, C extends string = CoreErrorCode> {
  readonly [SERVICE_MARK]: true;
  readonly name: string;
  readonly capability: Capability;
  readonly input: z.ZodType;
  call(
    runtime: ServiceRuntime,
    ctx: TenantContext,
    input: In,
  ): Promise<Result<T, ServiceError<C | CoreErrorCode>>>;
}

// biome-ignore lint/suspicious/noExplicitAny: any service, whatever its input/output types.
export type AnyService = Service<any, any, string>;

/** The input type a service's `call` accepts. */
export type ServiceInput<S> = S extends Service<infer In, unknown, string> ? In : never;

export function isService(value: unknown): value is AnyService {
  return typeof value === "object" && value !== null && SERVICE_MARK in value;
}

const SERVICE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Thrown inside the transaction to roll back a call whose `run` returned `err`. */
class Rollback {
  constructor(readonly error: ServiceError<string>) {}
}

class AuditMissingError extends Error {
  constructor(service: string) {
    super(`Service ${service} has an audited capability but recorded no audit event`);
    this.name = "AuditMissingError";
  }
}

export function defineService<S extends z.ZodType, T, C extends string = never>(
  definition: ServiceDefinition<S, T, C>,
): Service<z.input<S>, T, C> {
  const { name, capability } = definition;
  if (!SERVICE_NAME.test(name)) {
    throw new TypeError(`defineService: name must be dotted snake_case (a.b), got "${name}"`);
  }
  if (!isCapability(capability)) {
    throw new TypeError(`defineService(${name}): unknown capability "${String(capability)}"`);
  }
  const spec = capabilitySpec(capability);
  const accessMode = spec.kind === "read" && !spec.audited ? "read only" : "read write";
  const txOptions: TxOptions = {
    accessMode,
    ...(definition.isolationLevel ? { isolationLevel: definition.isolationLevel } : {}),
  };

  async function call(
    runtime: ServiceRuntime,
    ctx: TenantContext,
    rawInput: z.input<S>,
  ): Promise<Result<T, ServiceError<C | CoreErrorCode>>> {
    assertIssuedTenantContext(ctx);
    const started = Date.now();
    const log = runtime.logger.child({
      request_id: ctx.requestId,
      operator_id: ctx.operatorId,
      user_id: ctx.userId,
      role: ctx.role,
      channel: ctx.channel,
      service: name,
      capability,
    });
    const finish = (
      result: Result<T, ServiceError<C | CoreErrorCode>>,
      cause?: unknown,
    ): Result<T, ServiceError<C | CoreErrorCode>> => {
      const duration_ms = Date.now() - started;
      if (result.ok) {
        log.info("service.completed", { duration_ms });
      } else if (isExpectedError(result.error.code)) {
        log.info("service.failed", { duration_ms, error_code: result.error.code });
      } else {
        log.error("service.failed", {
          duration_ms,
          error_code: result.error.code,
          ...(cause === undefined ? {} : errorLogFields(cause)),
        });
      }
      return result;
    };

    const role = assertRole(ctx, capability);
    if (!role.ok) return finish(role);

    const parsed = definition.input.safeParse(rawInput);
    if (!parsed.success) return finish(err(validationError(parsed.error)));
    const input = parsed.data as z.output<S>;

    try {
      const value = await runtime.db.withTenant(
        ctx.operatorId,
        async (tx) => {
          const writable = await assertWritable(tx, capability);
          if (!writable.ok) throw new Rollback(writable.error);
          const audit = createAuditRecorder(tx, ctx, name);
          const result = await definition.run({ ctx, input, tx, audit, log, now: runtime.now() });
          if (!result.ok) throw new Rollback(result.error);
          if (spec.audited && audit.recorded === 0 && audit.skipped === undefined) {
            throw new AuditMissingError(name);
          }
          return result.value;
        },
        txOptions,
      );
      return finish(ok(value));
    } catch (error) {
      if (error instanceof Rollback) {
        return finish(err(error.error as ServiceError<C | CoreErrorCode>));
      }
      // A PII log in a test must fail the test, not turn into an INTERNAL result.
      if (error instanceof PiiInLogError) throw error;
      const mapped = toServiceError(error);
      return finish(err(mapped), mapped.code === "INTERNAL" ? error : undefined);
    }
  }

  return Object.freeze({
    [SERVICE_MARK]: true as const,
    name,
    capability,
    input: definition.input,
    call,
  });
}
