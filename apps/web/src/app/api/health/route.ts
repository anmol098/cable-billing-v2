import { serverEnv } from "@/env";
import { getHealth } from "@/lib/health";

/** Uptime checks hit this (PLAN §4). Node.js runtime, never cached (E-06). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await getHealth({ commit: serverEnv.VERCEL_GIT_COMMIT_SHA });
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
