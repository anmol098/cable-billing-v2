/** `POST /api/mobile/v1/auth/login` (T-028, contract `@cb/contracts`). See `@/lib/mobile/handlers`. */
import { loginHandler } from "@/lib/mobile/handlers";
import { getMobileDeps } from "@/lib/mobile/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = loginHandler(getMobileDeps);
