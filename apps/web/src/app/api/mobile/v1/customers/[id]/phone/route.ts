/**
 * `PATCH /api/mobile/v1/customers/{id}/phone` (T-060, contract `updateCustomerPhone`). See
 * `../../_lib/customers.ts`.
 */
import { getMobileDeps } from "@/lib/mobile/server";
import { updatePhoneHandler } from "../../_lib/customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = updatePhoneHandler(getMobileDeps);
