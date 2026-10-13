/** `GET /api/mobile/v1/app/config` (T-028, contract `@cb/contracts`). See `@/lib/mobile/handlers`. */
import { appConfigHandler } from "@/lib/mobile/handlers";
import { getMobileDeps } from "@/lib/mobile/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = appConfigHandler(getMobileDeps);
