/** `POST /api/mobile/v1/receipts/actions:batch` (T-061, contract `postReceiptActions`). See `../_lib`. */
import { getMobileDeps } from "@/lib/mobile/server";
import { receiptActionsHandler } from "../_lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = receiptActionsHandler(getMobileDeps);
