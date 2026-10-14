import { serverEnv } from "@/env";
import { databasePing, getHealth } from "@/lib/health";

/**
 * Uptime checks hit this every minute (PLAN §4, T-096 `alerts.json`). Node.js runtime, never cached
 * (E-06). 200 when everything answers; 503 `degraded` when the database does not answer `select 1`
 * within 2 s (T-096a). The body carries statuses only: no error text, host or timing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await getHealth({
    commit: serverEnv.VERCEL_GIT_COMMIT_SHA,
    pingDb: databasePing(serverEnv.DATABASE_URL),
  });
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
