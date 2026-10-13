/**
 * `POST /api/mobile/v1/payments:batch` (T-061; contract `postPaymentBatch`; PLAN §8.4, §10.4;
 * FR-015, FR-016; PRD §13.3; BR-11). Pushes up to 50 payments saved on the phone.
 *
 * - Auth, version gate and TenantContext come from `withMobileAuth` (T-028): every request
 *   re-reads the user, the operator, the device and the token family, so a disabled lineman
 *   (403 ACCOUNT_DISABLED), a signed-out or revoked phone (401 DEVICE_REVOKED), a logged-out or
 *   reused token family and a forged or expired token (401 UNAUTHENTICATED) post **nothing**: the
 *   whole request fails and the phone keeps every payment (BR-11).
 * - The body is checked as an envelope (`PaymentBatchEnvelope`: 1–50 items), then **each item on
 *   its own** (`PaymentBatchItem`), so one malformed item is `rejected` (VALIDATION) and never sinks
 *   the batch.
 * - Each valid item goes through T-046 `postPayment` in **its own transaction**, in request order:
 *   a failed item rolls back only itself. `postPayment` is idempotent on the item id (per tenant):
 *   the same payment again → `duplicate` with the stored result (identical snapshots), the same id
 *   with other data → `rejected` ID_REUSED_WITH_DIFFERENT_DATA. Identity comes from the token: the
 *   phone's `collector_id` / `device_id` only raise review flags (`posted_needs_review`).
 * - Outcome mapping (contract `PaymentOutcome`):
 *   | `postPayment` | outcome | error |
 *   |---|---|---|
 *   | ok `posted` / `duplicate` / `posted_needs_review` | the same | null |
 *   | VALIDATION | `rejected` | VALIDATION + `fields` (`payments.<i>.<wire field>`) |
 *   | ID_REUSED_WITH_DIFFERENT_DATA | `rejected` | the same (differing field names in the message) |
 *   | NOT_FOUND (unknown or another tenant's customer) | `rejected` | CUSTOMER_NOT_FOUND |
 *   | CONFLICT (retryable), INTERNAL, anything else, a thrown error | `retry_later` | CONFLICT / INTERNAL |
 *   | time budget used up before the item started | `retry_later` | RATE_LIMITED |
 *   Unknown failures are `retry_later`, never `rejected`: nothing was saved, and a retry is safe
 *   (idempotent ids), while `rejected` would stop the phone from ever sending the payment again.
 * - Read-only tenants (D-13): `payments.record` is on the read-only allowlist, so payments post.
 * - Results are in request order, one per item, each echoing the item's id (lower case) and, for
 *   saved outcomes, the posted payment with its `provisional_ref` (T-066 needs both).
 */
import {
  ENDPOINTS,
  PaymentBatchEnvelope,
  PaymentBatchItem,
  type PaymentBatchResponse,
} from "@cb/contracts";
import { errorLogFields, PiiInLogError, type PostPaymentResult, postPayment } from "@cb/core";
import * as Sentry from "@sentry/nextjs";
import {
  type AuthenticatedScope,
  fieldProblems,
  type MobileDeps,
  type ReplyBody,
  readJsonBody,
  withMobileAuth,
} from "@/lib/mobile/http";
import {
  coreFieldIssues,
  differingFields,
  type ItemErrorWire,
  itemError,
  itemIdOf,
} from "./wire-errors";

/** Stop starting new items after this long (the rest are `retry_later`), well inside `maxDuration`. */
export const PAYMENT_BATCH_TIME_BUDGET_MS = 30_000;

export interface PaymentBatchOptions {
  /** Default {@link PAYMENT_BATCH_TIME_BUDGET_MS}. Measured with the runtime clock. */
  readonly timeBudgetMs?: number;
}

type Endpoint = typeof ENDPOINTS.postPaymentBatch;
type ResultWire = ReplyBody<Endpoint>["results"][number];
type PostedPaymentWire = NonNullable<ResultWire["payment"]>;

/** T-046 result → contract `PostedPayment` (snake_case, ISO instants). */
export function postedPaymentWire(
  result: PostPaymentResult,
  sentProvisionalRef: string,
): PostedPaymentWire {
  const { payment, receipt } = result;
  return {
    id: payment.id,
    customer_id: payment.customerId,
    amount_paise: payment.amountPaise,
    method: payment.method,
    receipt_number: receipt.receiptNumber,
    // Compared for idempotency, so the stored alias equals what the phone sent.
    provisional_ref: receipt.provisionalRef ?? sentProvisionalRef,
    recorded_at: payment.recordedAt.toISOString(),
    posted_at: payment.postedAt.toISOString(),
    business_date: payment.businessDate,
    allocations: result.allocations.map((a) => ({
      invoice_id: a.invoiceId,
      invoice_number: a.invoiceNumber,
      kind: a.invoiceKind,
      period: a.period,
      amount_paise: a.amountPaise,
      outstanding_after_paise: a.outstandingAfterPaise,
    })),
    credit_added_paise: result.creditAddedPaise,
    balance_after_paise: result.newBalance,
    credit_after_paise: result.credit,
  };
}

function notSaved(
  id: string,
  outcome: "rejected" | "retry_later",
  error: ItemErrorWire,
): ResultWire {
  return { id, outcome, payment: null, review_reason: null, error };
}

/** One item: validate, post, map. Never throws (except a PII-in-logs test failure). */
async function postItem(
  scope: AuthenticatedScope<Endpoint, unknown>,
  raw: unknown,
  index: number,
): Promise<ResultWire> {
  const id = itemIdOf(raw);
  const parsed = PaymentBatchItem.safeParse(raw);
  if (!parsed.success) {
    return notSaved(
      id,
      "rejected",
      itemError(
        "VALIDATION",
        "payment does not match the contract",
        fieldProblems(parsed.error, `payments.${index}`),
      ),
    );
  }
  const item = parsed.data;
  let result: Awaited<ReturnType<typeof postPayment.call>>;
  try {
    result = await postPayment.call(scope.deps.runtime, scope.ctx, {
      id: item.id,
      customerId: item.customer_id,
      amountPaise: item.amount_paise,
      method: item.method,
      upiReference: item.upi_reference ?? null,
      notes: item.notes ?? null,
      recordedAt: item.recorded_at,
      provisionalRef: item.provisional_ref,
      claimedCollectorId: item.collector_id,
      claimedDeviceId: item.device_id,
    });
  } catch (error) {
    if (error instanceof PiiInLogError) throw error;
    scope.log.error("mobile_api.payment_item_failed", { index, ...errorLogFields(error) });
    Sentry.captureException(error, { tags: { endpoint: "postPaymentBatch" } });
    return notSaved(id, "retry_later", itemError("INTERNAL", "temporary server problem"));
  }

  if (result.ok) {
    const { outcome } = result.value;
    return {
      id,
      outcome,
      payment: postedPaymentWire(result.value, item.provisional_ref),
      review_reason:
        outcome === "posted_needs_review" ? (result.value.payment.reviewReason ?? "other") : null,
      error: null,
    };
  }

  const { code, details } = result.error;
  switch (code) {
    case "VALIDATION":
      return notSaved(
        id,
        "rejected",
        itemError(
          "VALIDATION",
          "payment failed validation",
          coreFieldIssues(details, `payments.${index}`),
        ),
      );
    case "ID_REUSED_WITH_DIFFERENT_DATA": {
      const names = differingFields(details);
      return notSaved(
        id,
        "rejected",
        itemError(
          code,
          `payment id already used with different data${names.length > 0 ? ` (${names.join(", ")})` : ""}`,
        ),
      );
    }
    case "NOT_FOUND":
      return notSaved(id, "rejected", itemError("CUSTOMER_NOT_FOUND", "customer not found"));
    case "CONFLICT":
      return notSaved(id, "retry_later", itemError("CONFLICT", "concurrent update; send again"));
    default:
      scope.log.warn("mobile_api.payment_item_retry_later", { index, error_code: code });
      return notSaved(id, "retry_later", itemError("INTERNAL", "temporary server problem"));
  }
}

export function paymentBatchHandler(getDeps: () => MobileDeps, options: PaymentBatchOptions = {}) {
  const budgetMs = options.timeBudgetMs ?? PAYMENT_BATCH_TIME_BUDGET_MS;
  return withMobileAuth(ENDPOINTS.postPaymentBatch, getDeps, async (scope) => {
    const body = await readJsonBody(scope, PaymentBatchEnvelope);
    if (!body.ok) return body.response;

    const clock = () => scope.deps.runtime.now().getTime();
    const started = clock();
    const results: ResultWire[] = [];
    for (const [index, raw] of body.value.payments.entries()) {
      if (clock() - started >= budgetMs) {
        results.push(
          notSaved(
            itemIdOf(raw),
            "retry_later",
            itemError("RATE_LIMITED", "batch time budget used up; send the rest again"),
          ),
        );
        continue;
      }
      results.push(await postItem(scope, raw, index));
    }

    const counts: Record<PaymentBatchResponse["results"][number]["outcome"], number> = {
      posted: 0,
      duplicate: 0,
      posted_needs_review: 0,
      rejected: 0,
      retry_later: 0,
    };
    for (const r of results) counts[r.outcome] += 1;
    scope.log.info("mobile_api.payment_batch", {
      items: results.length,
      ...counts,
      duration_ms: clock() - started,
    });
    return scope.reply.ok({ results });
  });
}
