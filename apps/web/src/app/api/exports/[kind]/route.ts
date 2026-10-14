/**
 * `GET /api/exports/<kind>?<the page's filters>` (T-082, FR-029, RULE-22): a streamed CSV of the
 * customer list, bills, payments or any report, with the same query parameters as its page.
 *
 * - **Owner only**, checked here and again by `@cb/core` (`exports.csv`): Staff get **403**.
 *   No session → the sign-in page (like every operator page).
 * - Refused when another site starts it (`Sec-Fetch-Site: cross-site`): a download is a GET, so the
 *   browser's own header is the CSRF check.
 * - **Rate-limited** per person and **audited** (`exports.download`) before the first row is sent.
 * - Bad filters, another business's id or too many downloads → back to the download page with
 *   the reason in words (303).
 * - Words in the reader's language; never cached; the file name says when its numbers are from.
 */
import {
  CSV_CONTENT_TYPE,
  can,
  EXPORT_KINDS,
  errorLogFields,
  exportFileStem,
  openExport,
} from "@cb/core";
import { getTranslations } from "next-intl/server";
import {
  exportInputFromParams,
  kindOfSlug,
  paramsOf,
} from "@/app/(operator)/reports/_export/params";
import { csvStream } from "@/app/(operator)/reports/_export/stream";
import { getRateLimiter, getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Long exports stream for a while (Vercel's default limit would cut them). */
export const maxDuration = 300;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
} as const;

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Back to the download page with the reason (`?problem=`). */
function problem(code: "bad_filters" | "not_found" | "too_many" | "failed", wait?: number) {
  const query = new URLSearchParams({ problem: code });
  if (wait !== undefined) query.set("wait", String(Math.max(1, Math.ceil(wait / 60))));
  return new Response(null, {
    status: 303,
    headers: { ...PRIVATE_HEADERS, Location: `/reports/export?${query.toString()}` },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const kind = kindOfSlug((await params).kind, EXPORT_KINDS);
  if (!kind) return text("Not found", 404);
  if (request.headers.get("sec-fetch-site") === "cross-site") return text("Forbidden", 403);

  const ctx = await getTenantContext();
  const t = await getTranslations();
  if (!can(ctx.role, "exports.csv")) return text(t("exports.forbidden"), 403);

  const runtime = getServerRuntime();
  const input = exportInputFromParams(
    kind,
    paramsOf(new URL(request.url).searchParams),
    runtime.now(),
  );
  const opened = await openExport(runtime, ctx, input, { rateLimiter: getRateLimiter() });
  if (!opened.ok) {
    switch (opened.error.code) {
      case "FORBIDDEN":
        return text(t("exports.forbidden"), 403);
      case "VALIDATION":
        return problem("bad_filters");
      case "NOT_FOUND":
        return problem("not_found");
      case "RATE_LIMITED": {
        const wait = Number(opened.error.details?.retryAfterSeconds ?? 60);
        return problem("too_many", wait);
      }
      default:
        return problem("failed");
    }
  }

  const handle = opened.value;
  const file = `${exportFileStem(kind, handle.asOf)}.csv`;
  const log = runtime.logger.child({ request_id: ctx.requestId, operator_id: ctx.operatorId });
  const body = csvStream(handle, t as never, (error) =>
    log.error("exports.stream_failed", { kind, ...errorLogFields(error) }),
  );
  return new Response(body, {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": CSV_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${file}"`,
    },
  });
}
