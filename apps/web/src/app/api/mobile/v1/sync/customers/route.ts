/** `GET /api/mobile/v1/sync/customers` (T-060, contract `syncCustomers`). See `../_lib/sync.ts`. */
import { getMobileDeps } from "@/lib/mobile/server";
import { syncCustomersHandler } from "../_lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = syncCustomersHandler(getMobileDeps);
