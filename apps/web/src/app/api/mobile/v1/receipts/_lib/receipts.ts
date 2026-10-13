/**
 * Receipts on the phone (T-061 over T-050's links and core `recordReceiptAction`; contract
 * `createReceiptLink` and `postReceiptActions`; PLAN §11.7, FR-017 to FR-021; BR-12, RULE-19).
 *
 * `POST /api/mobile/v1/receipts/{paymentId}/link` → `createReceiptLink`:
 * - 200 `{ link: { url, expires_at, receipt_number } }`: a **new** 90-day link on every call (T-050
 *   stores only the token's hash, so an earlier URL can't be rebuilt; earlier links keep working).
 * - 404 PAYMENT_NOT_FOUND: the payment isn't on the server yet ("Link will be ready after sync"),
 *   or it is another tenant's (same answer, nothing leaks).
 * - 429 RATE_LIMITED: the receipt already has 20 live links (T-050 CONFLICT `too_many_links`).
 * - 500 INTERNAL, before any link is made, when the receipt origin isn't https (the contract's
 *   `url` is https only; set `RECEIPT_BASE_URL` / `APP_BASE_URL`).
 *
 * `POST /api/mobile/v1/receipts/actions:batch` → `recordReceiptAction` per item (own transaction):
 * observable states only (`printed`, `print_failed`, `whatsapp_opened`, `sms_opened`,
 * `pdf_shared`; never "sent"/"delivered"). Per item: `recorded` / `duplicate`; `rejected` for
 * VALIDATION (incl. a dishonest action value) and ID_REUSED_WITH_DIFFERENT_DATA; `retry_later` for
 * PAYMENT_NOT_FOUND (not synced yet, as the contract says) and any temporary failure.
 *
 * Both are allowed in read-only tenants (D-13: `receipts.share` is on the allowlist).
 */
import {
  ENDPOINTS,
  ReceiptActionItem,
  ReceiptActionsEnvelope,
  ReceiptLinkParams,
} from "@cb/contracts";
import {
  createReceiptLink,
  errorLogFields,
  PiiInLogError,
  receiptLinkUrl,
  recordReceiptAction,
} from "@cb/core";
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
  differingFields,
  type ItemErrorWire,
  itemError,
  itemIdOf,
} from "../../payments/_lib/wire-errors";

/** Seconds the phone waits before asking again after `too_many_links`. */
export const TOO_MANY_LINKS_RETRY_AFTER_SECONDS = 3600;

export interface ReceiptLinkOptions {
  /** The public origin of receipt links (production: `baseUrls().receipt`). */
  readonly receiptOrigin: () => string;
}

type PaymentIdParams = { paymentId?: string };

export function receiptLinkHandler(getDeps: () => MobileDeps, options: ReceiptLinkOptions) {
  return withMobileAuth<typeof ENDPOINTS.createReceiptLink, PaymentIdParams>(
    ENDPOINTS.createReceiptLink,
    getDeps,
    async (scope) => {
      const params = ReceiptLinkParams.safeParse({ paymentId: scope.params.paymentId });
      if (!params.success) {
        return scope.reply.error("VALIDATION", "paymentId is not a UUID", {
          fields: fieldProblems(params.error),
        });
      }
      const origin = options.receiptOrigin();
      if (!origin.startsWith("https://")) {
        scope.log.error("mobile_api.receipt_origin_not_https", {});
        return scope.reply.error("INTERNAL", "receipt links need an https receipt origin");
      }
      const result = await createReceiptLink.call(scope.deps.runtime, scope.ctx, {
        paymentId: params.data.paymentId,
      });
      if (!result.ok) {
        const { code, details } = result.error;
        if (code === "NOT_FOUND") {
          return scope.reply.error("PAYMENT_NOT_FOUND", "payment not on the server (yet)");
        }
        if (code === "CONFLICT" && details?.reason === "too_many_links") {
          return scope.reply.error("RATE_LIMITED", "this receipt has too many open links", {
            retryAfterSeconds: TOO_MANY_LINKS_RETRY_AFTER_SECONDS,
          });
        }
        return scope.reply.serviceError(result.error);
      }
      const link = result.value;
      return scope.reply.ok({
        link: {
          url: receiptLinkUrl(origin, link.token),
          expires_at: link.expiresAt.toISOString(),
          receipt_number: link.receiptNumber,
        },
      });
    },
  );
}

type ActionsEndpoint = typeof ENDPOINTS.postReceiptActions;
type ActionResultWire = ReplyBody<ActionsEndpoint>["results"][number];

function failed(
  id: string,
  outcome: "rejected" | "retry_later",
  error: ItemErrorWire,
): ActionResultWire {
  return { id, outcome, error };
}

async function recordItem(
  scope: AuthenticatedScope<ActionsEndpoint, unknown>,
  raw: unknown,
  index: number,
): Promise<ActionResultWire> {
  const id = itemIdOf(raw);
  const parsed = ReceiptActionItem.safeParse(raw);
  if (!parsed.success) {
    return failed(
      id,
      "rejected",
      itemError(
        "VALIDATION",
        "action does not match the contract",
        fieldProblems(parsed.error, `actions.${index}`),
      ),
    );
  }
  const item = parsed.data;
  let result: Awaited<ReturnType<typeof recordReceiptAction.call>>;
  try {
    result = await recordReceiptAction.call(scope.deps.runtime, scope.ctx, {
      id: item.id,
      paymentId: item.payment_id,
      action: item.action,
      at: item.at,
    });
  } catch (error) {
    if (error instanceof PiiInLogError) throw error;
    scope.log.error("mobile_api.receipt_action_failed", { index, ...errorLogFields(error) });
    Sentry.captureException(error, { tags: { endpoint: "postReceiptActions" } });
    return failed(id, "retry_later", itemError("INTERNAL", "temporary server problem"));
  }
  if (result.ok) return { id, outcome: result.value.outcome, error: null };
  const { code, details } = result.error;
  switch (code) {
    case "VALIDATION":
      return failed(id, "rejected", itemError("VALIDATION", "action failed validation"));
    case "ID_REUSED_WITH_DIFFERENT_DATA": {
      const names = differingFields(details);
      return failed(
        id,
        "rejected",
        itemError(
          code,
          `action id already used with different data${names.length > 0 ? ` (${names.join(", ")})` : ""}`,
        ),
      );
    }
    case "NOT_FOUND":
      return failed(id, "retry_later", itemError("PAYMENT_NOT_FOUND", "payment not posted yet"));
    default:
      scope.log.warn("mobile_api.receipt_action_retry_later", { index, error_code: code });
      return failed(id, "retry_later", itemError("INTERNAL", "temporary server problem"));
  }
}

export function receiptActionsHandler(getDeps: () => MobileDeps) {
  return withMobileAuth(ENDPOINTS.postReceiptActions, getDeps, async (scope) => {
    const body = await readJsonBody(scope, ReceiptActionsEnvelope);
    if (!body.ok) return body.response;
    const results: ActionResultWire[] = [];
    for (const [index, raw] of body.value.actions.entries()) {
      results.push(await recordItem(scope, raw, index));
    }
    scope.log.info("mobile_api.receipt_actions", {
      items: results.length,
      recorded: results.filter((r) => r.outcome === "recorded").length,
      duplicate: results.filter((r) => r.outcome === "duplicate").length,
      rejected: results.filter((r) => r.outcome === "rejected").length,
      retry_later: results.filter((r) => r.outcome === "retry_later").length,
    });
    return scope.reply.ok({ results });
  });
}
