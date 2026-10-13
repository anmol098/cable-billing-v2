/** `POST /api/mobile/v1/auth/logout` (T-028, contract `@cb/contracts`). See `@/lib/mobile/handlers`. */
import { logoutHandler } from "@/lib/mobile/handlers";
import { getMobileDeps } from "@/lib/mobile/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = logoutHandler(getMobileDeps);
