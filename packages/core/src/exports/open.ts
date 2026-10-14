/**
 * `openExport` (T-082): starts an export and hands back its rows page by page, for a streamed
 * download.
 *
 * In order:
 * 1. **Owner only**: `can(ctx.role, "exports.csv")` or FORBIDDEN, before anything else.
 * 2. **Filters** checked (VALIDATION).
 * 3. **Rate limit** (when a limiter is passed): {@link EXPORT_RATE_LIMIT} per person, else
 *    RATE_LIMITED with `details.retryAfterSeconds`. A limiter that is down lets the export
 *    through (logged), like sign-up does.
 * 4. **The first page** is read (the service's own checks: another tenant's id → NOT_FOUND, a day
 *    range or "as of" day it refuses → VALIDATION), so a failure is an error result, not half a
 *    file, and a refused export writes nothing.
 * 5. **`exports.download`** (./service.ts): the Owner-only gate again, the filter ids again, and
 *    one audit event. Only then are rows handed out.
 *
 * Rows come from **the services the pages use** (no second query): `customers.search`,
 * `payments.list` and the T-080 / T-081 report services, each page in its own short READ ONLY
 * transaction, so nothing is held open while the file is sent. Report pages are
 * {@link EXPORT_REPORT_PAGE_SIZE} rows, lists 100. An export has at most {@link EXPORT_MAX_ROWS}
 * rows (the customer list and payment register also stop at their deepest offset, 10,100 rows);
 * past that `truncated` is set and the file says so.
 *
 * Known limit: pages are separate snapshots. The "as of" time is the first page's; a payment that
 * reaches the office during a long export can move a later page by a row.
 */
import type { Result } from "@cb/domain";
import { err, ok } from "@cb/domain";
import { type RateLimiter, type RateLimitRule, rateLimitKey } from "../auth/rate-limit";
import { can } from "../authz/capabilities";
import type { ServiceRuntime } from "../context/runtime";
import type { Service } from "../context/service";
import type { TenantContext } from "../context/tenant-context";
import { MAX_CUSTOMER_OFFSET, MAX_CUSTOMER_PAGE_SIZE, searchCustomers } from "../customers/queries";
import {
  type CoreErrorCode,
  type ServiceError,
  serviceError,
  validationError,
} from "../errors/errors";
import { errorLogFields } from "../logging/logger";
import {
  listPayments,
  MAX_PAYMENT_OFFSET,
  MAX_PAYMENT_PAGE_SIZE,
} from "../payment-register/queries";
import { REPORT_MAX_PAGE_SIZE } from "../reports/dues/as-of";
import { duesReport } from "../reports/dues/queries";
import { billingRunReport } from "../reports/operations/billing-runs";
import { collectionsReport } from "../reports/operations/collections";
import { connectionsReport } from "../reports/operations/connections";
import { handoverReport } from "../reports/operations/handover";
import { billRegisterReport } from "../reports/registers/bills";
import {
  type ExportCommand,
  type ExportFilters,
  ExportInput,
  type ExportKind,
  type ExportRowTypes,
} from "./kinds";
import { type StartedExport, startExport } from "./service";

/** Rows per report page read by an export (the report services' maximum). */
export const EXPORT_REPORT_PAGE_SIZE = REPORT_MAX_PAGE_SIZE;
/** Rows one export has at most (about 7 MB of CSV). */
export const EXPORT_MAX_ROWS = 50_000;
/** Exports per person (any kind). Generous for real use, a stop for a script or a stuck button. */
export const EXPORT_RATE_LIMIT: RateLimitRule = { limit: 30, windowSeconds: 15 * 60 };

export type ExportErrorCode = CoreErrorCode | "RATE_LIMITED";

/** Page sizes and the row cap (tests make them small to walk many pages). */
export interface ExportLimits {
  readonly reportPageSize: number;
  readonly listPageSize: number;
  readonly maxRows: number;
}

const DEFAULT_LIMITS: ExportLimits = {
  reportPageSize: EXPORT_REPORT_PAGE_SIZE,
  listPageSize: Math.min(MAX_CUSTOMER_PAGE_SIZE, MAX_PAYMENT_PAGE_SIZE),
  maxRows: EXPORT_MAX_ROWS,
};

/** One page of rows and whether more may follow. */
interface PageResult<K extends ExportKind> {
  readonly rows: readonly ExportRowTypes[K][];
  readonly more: boolean;
  /** The report's own "as of" instant (reports only). */
  readonly asOf?: Date;
}

/** Reads page `page` (1-based), or `"end"` when the service can't go that deep. */
type PageReader<K extends ExportKind> = (
  runtime: ServiceRuntime,
  ctx: TenantContext,
  filters: ExportFilters<K>,
  page: number,
  limits: ExportLimits,
) => Promise<Result<PageResult<K>, ServiceError<string>> | "end">;

/** What a report service returns that an export needs. */
interface ReportPage<Row> {
  readonly rows: readonly Row[];
  readonly asOf: { readonly at: Date };
  /** Rows over every page, when the service says (collections). */
  readonly rowCount?: number;
}

/** A report service page (`page` + `pageSize`); `more` while a page comes back full. */
function reportPage<K extends ExportKind>(
  // biome-ignore lint/suspicious/noExplicitAny: the filters were parsed by this service's own input.
  service: Service<any, ReportPage<ExportRowTypes[K]>, string>,
): PageReader<K> {
  return async (runtime, ctx, filters, page, { reportPageSize: size }) => {
    if (page > 10_000) return "end";
    const result = await service.call(runtime, ctx, {
      ...(filters as object),
      page,
      pageSize: size,
    });
    if (!result.ok) return result;
    const { rows, asOf, rowCount } = result.value;
    const more = rowCount === undefined ? rows.length === size : page * size < rowCount;
    return ok({ rows, more, asOf: asOf.at });
  };
}

/** A list service page (`limit` + `offset`, `hasMore`), down to its deepest offset. */
function listPage<K extends ExportKind>(
  // biome-ignore lint/suspicious/noExplicitAny: the filters were parsed by this service's own input.
  service: Service<any, { rows: readonly ExportRowTypes[K][]; hasMore: boolean }, string>,
  maxOffset: number,
): PageReader<K> {
  return async (runtime, ctx, filters, page, { listPageSize: limit }) => {
    const offset = (page - 1) * limit;
    if (offset > maxOffset) return "end";
    const result = await service.call(runtime, ctx, { ...(filters as object), limit, offset });
    if (!result.ok) return result;
    return ok({ rows: result.value.rows, more: result.value.hasMore });
  };
}

const READERS: { readonly [K in ExportKind]: PageReader<K> } = {
  customers: listPage(searchCustomers, MAX_CUSTOMER_OFFSET),
  payments: listPage(listPayments, MAX_PAYMENT_OFFSET),
  bills: reportPage(billRegisterReport),
  dues: reportPage(duesReport),
  collections: reportPage(collectionsReport),
  handover: reportPage(handoverReport),
  connections: reportPage(connectionsReport),
  billing_runs: reportPage(billingRunReport),
};

/** An export that has started: its rows, page by page. */
export interface ExportHandle<K extends ExportKind = ExportKind> {
  readonly kind: K;
  /** What the export is of (filters as parsed, paging removed). */
  readonly filters: StartedExport["filters"];
  /** When the numbers are from: the report's "as of" (first page), else the start. */
  readonly asOf: Date;
  /** Every page, the first one included. Read it once. */
  pages(): AsyncGenerator<readonly ExportRowTypes[K][], void, undefined>;
  /** After `pages()` has finished: true when rows were left out (past the limits above). */
  readonly truncated: boolean;
}

/** A handle of whichever kind was asked for (switch on `kind`). */
export type AnyExportHandle = { [K in ExportKind]: ExportHandle<K> }[ExportKind];

export interface OpenExportOptions {
  /** Counts the export against `rateLimit` per person; leave out in tests and jobs. */
  readonly rateLimiter?: RateLimiter;
  /** Default {@link EXPORT_RATE_LIMIT}. */
  readonly rateLimit?: RateLimitRule;
  /** Default: {@link EXPORT_REPORT_PAGE_SIZE}, 100, {@link EXPORT_MAX_ROWS}. */
  readonly limits?: Partial<ExportLimits>;
}

async function rateLimited(
  runtime: ServiceRuntime,
  ctx: TenantContext,
  limiter: RateLimiter,
  rule: RateLimitRule,
): Promise<ServiceError<"RATE_LIMITED"> | null> {
  try {
    const key = rateLimitKey("exports:user", `${ctx.operatorId}:${ctx.userId}`);
    const result = await limiter.hit(key, rule);
    if (result.allowed) return null;
    runtime.logger.warn("exports.rate_limited", { operator_id: ctx.operatorId });
    return serviceError("RATE_LIMITED", "Too many exports", {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  } catch (error) {
    runtime.logger.error("exports.rate_limit_unavailable", {
      limiter: limiter.kind,
      ...errorLogFields(error),
    });
    return null;
  }
}

function handleFor<K extends ExportKind>(
  runtime: ServiceRuntime,
  ctx: TenantContext,
  command: Extract<ExportCommand, { kind: K }>,
  started: StartedExport,
  first: PageResult<K>,
  limits: ExportLimits,
): ExportHandle<K> {
  const read = READERS[command.kind] as PageReader<K>;
  const filters = command.filters as ExportFilters<K>;
  let truncated = false;
  let used = false;
  return {
    kind: command.kind,
    filters: started.filters,
    asOf: first.asOf ?? started.startedAt,
    get truncated() {
      return truncated;
    },
    async *pages() {
      if (used) throw new Error("ExportHandle.pages() can be read only once");
      used = true;
      let left = limits.maxRows;
      let current: PageResult<K> = first;
      for (let page = 1; ; page += 1) {
        if (page > 1) {
          const next = await read(runtime, ctx, filters, page, limits);
          if (next === "end") {
            truncated = true;
            return;
          }
          if (!next.ok) throw new Error(`export page ${page} failed: ${next.error.code}`);
          current = next.value;
        }
        const rows = current.rows.length > left ? current.rows.slice(0, left) : current.rows;
        left -= rows.length;
        if (rows.length > 0) yield rows;
        if (!current.more && rows.length === current.rows.length) return;
        if (left <= 0) {
          truncated = true;
          return;
        }
      }
    },
  };
}

export async function openExport(
  runtime: ServiceRuntime,
  ctx: TenantContext,
  input: ExportInput,
  options: OpenExportOptions = {},
): Promise<Result<AnyExportHandle, ServiceError<ExportErrorCode>>> {
  if (!can(ctx.role, "exports.csv")) return err(serviceError("FORBIDDEN"));
  const parsed = ExportInput.safeParse(input);
  if (!parsed.success) return err(validationError(parsed.error));
  const command = parsed.data;
  const limits: ExportLimits = { ...DEFAULT_LIMITS, ...options.limits };

  if (options.rateLimiter) {
    const rule = options.rateLimit ?? EXPORT_RATE_LIMIT;
    const limited = await rateLimited(runtime, ctx, options.rateLimiter, rule);
    if (limited) return err(limited);
  }

  // The first page before the audit event: some filters are only checked by the service itself
  // (a day range over 31 days, a future "as of" day), and a refused export writes nothing.
  // Nothing leaves this function before the audit event is committed.
  const read = READERS[command.kind] as PageReader<ExportKind>;
  const first = await read(runtime, ctx, command.filters as never, 1, limits);
  if (first === "end") return err(serviceError("INTERNAL", "first export page past the limit"));
  if (!first.ok) return err(first.error as ServiceError<ExportErrorCode>);

  const started = await startExport.call(runtime, ctx, input);
  if (!started.ok) return started;
  return ok(
    handleFor(runtime, ctx, command, started.value, first.value, limits) as AnyExportHandle,
  );
}
