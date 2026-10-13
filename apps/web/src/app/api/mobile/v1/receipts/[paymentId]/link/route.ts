/** `POST /api/mobile/v1/receipts/{paymentId}/link` (T-061, contract `createReceiptLink`). See `../../_lib`. */
import { baseUrls } from "@/env";
import { getMobileDeps } from "@/lib/mobile/server";
import { receiptLinkHandler } from "../../_lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = receiptLinkHandler(getMobileDeps, { receiptOrigin: () => baseUrls().receipt });
