/**
 * `POST /api/mobile/v1/payments:batch` (T-061, contract `postPaymentBatch`). The folder name is the
 * contract's path literally (PLAN §10.2). See `../payments/_lib/batch.ts`.
 */
import { getMobileDeps } from "@/lib/mobile/server";
import { paymentBatchHandler } from "../payments/_lib/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Seconds; the handler stops starting new items after `PAYMENT_BATCH_TIME_BUDGET_MS`. */
export const maxDuration = 60;

export const POST = paymentBatchHandler(getMobileDeps);
