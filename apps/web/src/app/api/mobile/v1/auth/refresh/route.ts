/** `POST /api/mobile/v1/auth/refresh` (T-028, contract `@cb/contracts`). See `@/lib/mobile/handlers`. */
import { refreshHandler } from "@/lib/mobile/handlers";
import { getMobileDeps } from "@/lib/mobile/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = refreshHandler(getMobileDeps);
