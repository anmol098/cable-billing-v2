/** `GET /api/mobile/v1/customers/{id}` (T-060, contract `getCustomer`). See `../_lib/customers.ts`. */
import { getMobileDeps } from "@/lib/mobile/server";
import { customerDetailHandler } from "../_lib/customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = customerDetailHandler(getMobileDeps);
