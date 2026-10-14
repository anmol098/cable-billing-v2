/**
 * `defineAdminService`: the one way to write a platform admin operation (T-086).
 *
 * What `call(runtime, ctx, input)` does, in order:
 * 1. refuses a context not issued by `resolveAdminContext` (throws: a programming error);
 * 2. **validate**: `input.safeParse` or VALIDATION (paths and codes, never values);
 * 3. **run** with the database client: the service opens its own transactions (`withPlatform` for
 *    platform data and aggregates, `withTenant(operatorId)` only for support access and the
 *    tenant's own records such as its subscription);
 * 4. **audit**: every successful call must have written at least one **platform** audit event
 *    (`audit.platform`, reads included: every cross-tenant read is on record) or the call fails
 *    with INTERNAL; tenant-visible actions also write a **tenant** event (`audit.tenant`), which
 *    the Owner sees in their audit log;
 * 5. **errors**: thrown errors are mapped (`toServiceError`), unexpected ones logged;
 * 6. **log**: one `admin_service.completed` / `admin_service.failed` line (ids and codes only).
 */
import type { Tx } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import type { z } from "zod";
import { writeAuditEvent } from "../audit/audit";
import type { ServiceRuntime } from "../context/runtime";
import {
  type CoreErrorCode,
  isExpectedError,
  type ServiceError,
  toServiceError,
  validationError,
} from "../errors/errors";
import { errorLogFields, type Logger, PiiInLogError } from "../logging/logger";
import { type AdminContext, assertIssuedAdminContext } from "./context";

/** One audit event written by an admin service. */
export interface AdminAuditEvent {
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface AdminAuditRecorder {
  /** A platform event (`operator_id` NULL) in a `withPlatform` transaction. */
  platform(tx: Tx, event: AdminAuditEvent): Promise<void>;
  /** An event in the tenant's own log, in that tenant's `withTenant` transaction. */
  tenant(tx: Tx, operatorId: string, event: AdminAuditEvent): Promise<void>;
}

export interface AdminServiceArgs<I> {
  readonly ctx: AdminContext;
  readonly input: I;
  readonly runtime: ServiceRuntime;
  readonly audit: AdminAuditRecorder;
  /** Logger with request_id, user_id and service set. No PII. */
  readonly log: Logger;
  /** The time of this call (runtime clock). */
  readonly now: Date;
}

export interface AdminServiceDefinition<S extends z.ZodType, T, C extends string> {
  /** Dotted snake_case (`admin.tenants_list`). */
  readonly name: string;
  readonly input: S;
  run(args: AdminServiceArgs<z.output<S>>): Promise<Result<T, ServiceError<C>>>;
}

export interface AdminService<In = unknown, T = unknown, C extends string = CoreErrorCode> {
  readonly name: string;
  readonly input: z.ZodType;
  call(
    runtime: ServiceRuntime,
    ctx: AdminContext,
    input: In,
  ): Promise<Result<T, ServiceError<C | CoreErrorCode>>>;
}

const SERVICE_NAME = /^admin\.[a-z][a-z0-9_]*$/;

class AdminAuditMissingError extends Error {
  constructor(service: string) {
    super(`Admin service ${service} wrote no platform audit event`);
    this.name = "AdminAuditMissingError";
  }
}

function recorder(ctx: AdminContext) {
  let platformEvents = 0;
  const common = {
    actorId: ctx.userId,
    actorRole: "platform_admin" as const,
    ip: ctx.client?.ip ?? null,
    userAgent: ctx.client?.userAgent ?? null,
    requestId: ctx.requestId,
  };
  const audit: AdminAuditRecorder = {
    async platform(tx, event) {
      await writeAuditEvent(tx, { ...common, ...event, operatorId: null });
      platformEvents += 1;
    },
    async tenant(tx, operatorId, event) {
      await writeAuditEvent(tx, { ...common, ...event, operatorId });
    },
  };
  return {
    audit,
    get platformEvents() {
      return platformEvents;
    },
  };
}

export function defineAdminService<S extends z.ZodType, T, C extends string = never>(
  definition: AdminServiceDefinition<S, T, C>,
): AdminService<z.input<S>, T, C> {
  const { name } = definition;
  if (!SERVICE_NAME.test(name)) {
    throw new TypeError(`defineAdminService: name must be admin.<snake_case>, got "${name}"`);
  }

  async function call(
    runtime: ServiceRuntime,
    ctx: AdminContext,
    rawInput: z.input<S>,
  ): Promise<Result<T, ServiceError<C | CoreErrorCode>>> {
    assertIssuedAdminContext(ctx);
    const started = Date.now();
    const log = runtime.logger.child({
      request_id: ctx.requestId,
      user_id: ctx.userId,
      role: "platform_admin",
      service: name,
    });
    const finish = (
      result: Result<T, ServiceError<C | CoreErrorCode>>,
      cause?: unknown,
    ): Result<T, ServiceError<C | CoreErrorCode>> => {
      const duration_ms = Date.now() - started;
      if (result.ok) log.info("admin_service.completed", { duration_ms });
      else if (isExpectedError(result.error.code)) {
        log.info("admin_service.failed", { duration_ms, error_code: result.error.code });
      } else {
        log.error("admin_service.failed", {
          duration_ms,
          error_code: result.error.code,
          ...(cause === undefined ? {} : errorLogFields(cause)),
        });
      }
      return result;
    };

    const parsed = definition.input.safeParse(rawInput);
    if (!parsed.success) return finish(err(validationError(parsed.error)));
    const tracked = recorder(ctx);
    try {
      const result = await definition.run({
        ctx,
        input: parsed.data as z.output<S>,
        runtime,
        audit: tracked.audit,
        log,
        now: runtime.now(),
      });
      if (!result.ok) return finish(result);
      if (tracked.platformEvents === 0) throw new AdminAuditMissingError(name);
      return finish(ok(result.value));
    } catch (error) {
      if (error instanceof PiiInLogError) throw error;
      const mapped = toServiceError(error);
      return finish(err(mapped), mapped.code === "INTERNAL" ? error : undefined);
    }
  }

  return Object.freeze({ name, input: definition.input, call });
}
