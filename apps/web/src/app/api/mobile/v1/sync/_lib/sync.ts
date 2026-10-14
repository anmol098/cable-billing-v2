/**
 * `GET /api/mobile/v1/sync/customers?cursor=&limit=` (T-060, contract `syncCustomers`, PLAN §10.3):
 * the lineman's roster, a page at a time, over `@cb/core` `mobile_sync.roster`.
 *
 * - No cursor: a full pass over the tenant's **active** customers (D-11: the whole tenant, any
 *   lineman may collect from any customer). With `next_cursor`: what changed since, with
 *   tombstones (`removed_customer_ids`) for customers closed since. Up to `limit` rows (customers +
 *   tombstones) per page, default and maximum 500; `has_more` says "ask again now with
 *   `next_cursor`". The cursor is built on transaction ids, so a change committed late is never
 *   skipped (see `packages/core/src/mobile-sync/cursor.ts`).
 * - 400 CURSOR_INVALID for a cursor that is malformed, another tenant's, or newer than the
 *   database (restored): the phone drops it and starts a full sync. 400 VALIDATION for a bad
 *   `limit`.
 * - The 200 body is gzip-compressed when the request accepts gzip (OkHttp sends
 *   `Accept-Encoding: gzip` by default): about 1,000 customers fit well under 1 MB.
 */
import { gzipSync } from "node:zlib";
import { ENDPOINTS, SyncCustomersQuery } from "@cb/contracts";
import { syncRoster } from "@cb/core";
import { fieldProblems, type MobileDeps, withMobileAuth } from "@/lib/mobile/http";
import { rosterCustomerWire } from "../../customers/_lib/wire";

/** Bodies smaller than this are sent as they are (gzip would not pay for its header). */
export const GZIP_MIN_BYTES = 1024;

/** True when the request's `Accept-Encoding` allows gzip (q > 0). */
export function acceptsGzip(request: Request): boolean {
  const header = request.headers.get("accept-encoding");
  if (!header) return false;
  return header.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * The same response, gzip-compressed when the client accepts it. Only 200 JSON bodies of at least
 * {@link GZIP_MIN_BYTES}; headers (no-store, content type) are kept and `Vary` is added.
 */
export async function gzipResponse(request: Request, response: Response): Promise<Response> {
  if (response.status !== 200 || response.headers.has("content-encoding")) return response;
  const body = Buffer.from(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.append("Vary", "Accept-Encoding");
  if (!acceptsGzip(request) || body.length < GZIP_MIN_BYTES) {
    return new Response(body, { status: response.status, headers });
  }
  const zipped = gzipSync(body);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(zipped.length));
  return new Response(zipped, { status: response.status, headers });
}

export function syncCustomersHandler(getDeps: () => MobileDeps) {
  return withMobileAuth(ENDPOINTS.syncCustomers, getDeps, async (scope) => {
    const url = new URL(scope.request.url);
    const raw: Record<string, string> = {};
    for (const key of ["cursor", "limit"] as const) {
      const value = url.searchParams.get(key);
      if (value !== null) raw[key] = value;
    }
    const query = SyncCustomersQuery.safeParse(raw);
    if (!query.success) {
      return scope.reply.error("VALIDATION", "query does not match the contract", {
        fields: fieldProblems(query.error, "query"),
      });
    }

    const result = await syncRoster.call(scope.deps.runtime, scope.ctx, {
      ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
      ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
    });
    if (!result.ok) {
      if (result.error.code === "CURSOR_INVALID") {
        const reason = (result.error.details as { reason?: unknown } | undefined)?.reason;
        scope.log.info("mobile_api.cursor_invalid", { reason: String(reason ?? "") });
        return scope.reply.error("CURSOR_INVALID", "cursor is not valid; start a full sync");
      }
      return scope.reply.serviceError(result.error);
    }
    const page = result.value;
    const response = scope.reply.ok({
      customers: page.customers.map(rosterCustomerWire),
      removed_customer_ids: [...page.removedCustomerIds],
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    });
    return gzipResponse(scope.request, response);
  });
}
