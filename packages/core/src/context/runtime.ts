/**
 * What services need from the process: the database client, the logger and the clock. apps/web
 * creates one runtime at module level and passes it to `resolveTenantContext` and `service.call`.
 *
 * ```ts
 * export const runtime = createServiceRuntime({ db: createDb({ connectionString }) });
 * ```
 */
import { type DbClient, uuidv7 } from "@cb/db";
import { createLogger, type Logger } from "../logging/logger";

export interface ServiceRuntime {
  readonly db: DbClient;
  readonly logger: Logger;
  /** The clock. Services get `now` from here (tests pass a fixed clock). */
  readonly now: () => Date;
}

export interface ServiceRuntimeOptions {
  readonly db: DbClient;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export function createServiceRuntime(options: ServiceRuntimeOptions): ServiceRuntime {
  return Object.freeze({
    db: options.db,
    logger: options.logger ?? createLogger(),
    now: options.now ?? (() => new Date()),
  });
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** True for a request id that is safe to log and store (no spaces, quotes or newlines). */
export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

/** A new request id (UUIDv7, so ids sort by time). */
export function newRequestId(): string {
  return uuidv7();
}

/**
 * The request id to use for an incoming request: the platform's header value (e.g.
 * `x-vercel-id` or `x-request-id`) when it is well-formed, otherwise a new one.
 */
export function requestIdFrom(header: string | null | undefined): string {
  return isRequestId(header) ? header : newRequestId();
}
