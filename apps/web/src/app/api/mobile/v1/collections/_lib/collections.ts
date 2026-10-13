/**
 * The lineman's day and cash handover (T-061 over T-062's services; contract `getCollectionDay`
 * and `submitHandover`; PLAN §8.7, FR-022, J-05):
 *
 * | Route | Service | Errors |
 * |---|---|---|
 * | `GET /api/mobile/v1/collections/{date}` | `getOwnCollectionDay` | 400 VALIDATION (bad or future `date`) |
 * | `POST /api/mobile/v1/collections/{date}/handover` | `submitHandover` | 400 VALIDATION (incl. a missing `discrepancy_reason`), 409 HANDOVER_ALREADY_ACCEPTED, 409 ID_REUSED_WITH_DIFFERENT_DATA, 429 RATE_LIMITED (a retryable concurrent update) |
 *
 * Always the **signed-in lineman's own** day: the services take the collector from the
 * TenantContext, and nothing in the request names a user, so another lineman's or another
 * tenant's day can't be read (another tenant's date is simply this lineman's empty day).
 * Handovers are idempotent on `submission_id` and allowed in read-only tenants (D-13).
 */
import { CollectionDateParams, ENDPOINTS, HandoverRequest } from "@cb/contracts";
import {
  type CollectionDayView,
  getOwnCollectionDay,
  type ServiceError,
  submitHandover,
} from "@cb/core";
import {
  fieldProblems,
  type MobileDeps,
  type Reply,
  type ReplyBody,
  readJsonBody,
  withMobileAuth,
} from "@/lib/mobile/http";
import { coreFieldIssues, differingFields } from "../../payments/_lib/wire-errors";

type DayWire = ReplyBody<typeof ENDPOINTS.getCollectionDay>["session"];

/** T-062 `CollectionDayView` → contract `CollectionDay` (snake_case, ISO instants). */
export function collectionDayWire(day: CollectionDayView): DayWire {
  const { handover } = day;
  return {
    business_date: day.businessDate,
    cash_total_paise: day.cashExpectedPaise,
    upi_total_paise: day.upiTotalPaise,
    payment_count: day.paymentCount,
    status: day.status,
    handover:
      handover === null
        ? null
        : {
            submission_id: handover.submissionId,
            cash_expected_paise: handover.cashExpectedPaise,
            cash_handed_over_paise: handover.cashHandedOverPaise,
            discrepancy_paise: handover.discrepancyPaise,
            discrepancy_reason: handover.discrepancyReason,
            note: handover.note,
            unsynced_payment_count: handover.unsyncedPaymentCount,
            unsynced_cash_paise: handover.unsyncedCashPaise,
            submitted_at: handover.submittedAt.toISOString(),
            reviewed_at: handover.reviewedAt?.toISOString() ?? null,
            review_note: handover.reviewNote,
          },
    payments: day.payments.map((p) => ({
      payment_id: p.paymentId,
      customer_id: p.customerId,
      customer_code: p.customerCode,
      customer_name: p.customerName,
      amount_paise: p.amountPaise,
      method: p.method,
      recorded_at: p.recordedAt.toISOString(),
      posted_at: p.postedAt.toISOString(),
      receipt_number: p.receiptNumber,
      provisional_ref: p.provisionalRef,
      reversed: p.reversed,
    })),
  };
}

type DateParams = { date?: string };

/** The error side of `Reply`, the same for every endpoint. */
type ErrorReply = Pick<Reply<typeof ENDPOINTS.submitHandover>, "error" | "serviceError">;

/** The `{date}` path parameter, or the 400 VALIDATION answer. */
function dateParam(
  params: DateParams,
  reply: ErrorReply,
): { ok: true; date: string } | { ok: false; response: Response } {
  const parsed = CollectionDateParams.safeParse({ date: params.date });
  if (!parsed.success) {
    return {
      ok: false,
      response: reply.error("VALIDATION", "date is not a YYYY-MM-DD business date", {
        fields: fieldProblems(parsed.error),
      }),
    };
  }
  return { ok: true, date: parsed.data.date };
}

/** A collection service error → the contract error (wire field names). */
function serviceErrorResponse(reply: ErrorReply, error: ServiceError<string>): Response {
  switch (error.code) {
    case "VALIDATION":
      return reply.error("VALIDATION", error.message ?? "input failed validation", {
        fields: coreFieldIssues(error.details),
      });
    case "ID_REUSED_WITH_DIFFERENT_DATA": {
      const names = differingFields(error.details);
      return reply.error(
        "ID_REUSED_WITH_DIFFERENT_DATA",
        `submission_id already used with different data${names.length > 0 ? ` (${names.join(", ")})` : ""}`,
      );
    }
    case "CONFLICT":
      if (error.details?.retryable === true) {
        // A deadlock/serialization retry: temporary for the phone (429), not "call office" (409).
        return reply.error("RATE_LIMITED", "concurrent update; send again", {
          retryAfterSeconds: 1,
        });
      }
      return reply.serviceError(error);
    default:
      return reply.serviceError(error);
  }
}

export function collectionDayHandler(getDeps: () => MobileDeps) {
  return withMobileAuth<typeof ENDPOINTS.getCollectionDay, DateParams>(
    ENDPOINTS.getCollectionDay,
    getDeps,
    async (scope) => {
      const date = dateParam(scope.params, scope.reply);
      if (!date.ok) return date.response;
      const result = await getOwnCollectionDay.call(scope.deps.runtime, scope.ctx, {
        businessDate: date.date,
      });
      if (!result.ok) return serviceErrorResponse(scope.reply, result.error);
      return scope.reply.ok({ session: collectionDayWire(result.value) });
    },
  );
}

export function submitHandoverHandler(getDeps: () => MobileDeps) {
  return withMobileAuth<typeof ENDPOINTS.submitHandover, DateParams>(
    ENDPOINTS.submitHandover,
    getDeps,
    async (scope) => {
      const date = dateParam(scope.params, scope.reply);
      if (!date.ok) return date.response;
      const body = await readJsonBody(scope, HandoverRequest);
      if (!body.ok) return body.response;
      const request = body.value;
      const result = await submitHandover.call(scope.deps.runtime, scope.ctx, {
        businessDate: date.date,
        submissionId: request.submission_id,
        cashHandedOverPaise: request.cash_handed_over_paise,
        discrepancyReason: request.discrepancy_reason ?? null,
        note: request.note ?? null,
        unsyncedPaymentCount: request.unsynced_payment_count,
        unsyncedCashPaise: request.unsynced_cash_paise,
      });
      if (!result.ok) return serviceErrorResponse(scope.reply, result.error);
      scope.log.info("mobile_api.handover", {
        outcome: result.value.outcome,
        status: result.value.day.status,
      });
      return scope.reply.ok({ session: collectionDayWire(result.value.day) });
    },
  );
}
