/**
 * The customer screen's server side (T-060; contract `getCustomer` and `updateCustomerPhone`;
 * PLAN §10.2, §11.7, FR-004):
 *
 * | Route | Service | Errors |
 * |---|---|---|
 * | `GET /api/mobile/v1/customers/{id}` | `mobile_sync.customer_detail` | 400 VALIDATION (`id` not a UUID), 404 CUSTOMER_NOT_FOUND |
 * | `PATCH /api/mobile/v1/customers/{id}/phone` | T-033 `customers.update_phone`, then `mobile_sync.roster_customer` | 400 VALIDATION, 404 CUSTOMER_NOT_FOUND, 403 TENANT_READ_ONLY, 429 RATE_LIMITED (a retryable concurrent update) |
 *
 * - Any customer of the operator (D-11: no area or assignment filter); another tenant's id, or an
 *   unknown one, is 404 CUSTOMER_NOT_FOUND with nothing about it in the answer.
 * - A closed (inactive) customer is answered with `active: false`; the phone treats it as a
 *   tombstone (T-064).
 * - The phone update is audited by T-033's service with the old and new number, the lineman and
 *   source `android` (`customer_contact_changes`), and is idempotent: the same number again answers
 *   `changed: false` and writes nothing. Read-only tenants (D-13) get 403 TENANT_READ_ONLY: the
 *   allowlist keeps collecting (payments, handovers, receipt links/actions) and viewing, and a
 *   contact edit is neither (contract `TENANT_READ_ONLY`).
 */
import { CustomerIdParams, ENDPOINTS, UpdatePhoneRequest } from "@cb/contracts";
import {
  getRosterCustomer,
  getRosterCustomerDetail,
  type ServiceError,
  updateCustomerPhone,
} from "@cb/core";
import {
  fieldProblems,
  type MobileDeps,
  type Reply,
  readJsonBody,
  withMobileAuth,
} from "@/lib/mobile/http";
import { openBillWire, recentPaymentWire, rosterCustomerWire } from "./wire";

type IdParams = { id?: string };

type ErrorReply = Pick<Reply<typeof ENDPOINTS.updateCustomerPhone>, "error" | "serviceError">;

/** The `{id}` path parameter (lower case), or the 400 VALIDATION answer. */
function customerIdParam(
  params: IdParams,
  reply: ErrorReply,
): { ok: true; id: string } | { ok: false; response: Response } {
  const parsed = CustomerIdParams.safeParse({ id: params.id });
  if (!parsed.success) {
    return {
      ok: false,
      response: reply.error("VALIDATION", "id is not a UUID", {
        fields: fieldProblems(parsed.error),
      }),
    };
  }
  return { ok: true, id: parsed.data.id.toLowerCase() };
}

/** A customers service error → the contract error. */
function customerErrorResponse(reply: ErrorReply, error: ServiceError<string>): Response {
  switch (error.code) {
    case "NOT_FOUND":
      return reply.error("CUSTOMER_NOT_FOUND", "no such customer");
    case "VALIDATION": {
      // Only the phone can be invalid here (the id was checked first).
      return reply.error("VALIDATION", "phone is not valid", {
        fields: [{ path: "phone", issue: "invalid_format" }],
      });
    }
    case "CONFLICT":
      if (error.details?.retryable === true) {
        // A deadlock/serialization retry: temporary for the phone (429), not "call office".
        return reply.error("RATE_LIMITED", "concurrent update; send again", {
          retryAfterSeconds: 1,
        });
      }
      return reply.error("INTERNAL", "unexpected conflict");
    default:
      return reply.serviceError(error);
  }
}

export function customerDetailHandler(getDeps: () => MobileDeps) {
  return withMobileAuth<typeof ENDPOINTS.getCustomer, IdParams>(
    ENDPOINTS.getCustomer,
    getDeps,
    async (scope) => {
      const id = customerIdParam(scope.params, scope.reply);
      if (!id.ok) return id.response;
      const result = await getRosterCustomerDetail.call(scope.deps.runtime, scope.ctx, {
        customerId: id.id,
      });
      if (!result.ok) return customerErrorResponse(scope.reply, result.error);
      const { customer, openBills, recentPayments } = result.value;
      return scope.reply.ok({
        customer: rosterCustomerWire(customer),
        open_bills: openBills.map(openBillWire),
        recent_payments: recentPayments.map(recentPaymentWire),
      });
    },
  );
}

export function updatePhoneHandler(getDeps: () => MobileDeps) {
  return withMobileAuth<typeof ENDPOINTS.updateCustomerPhone, IdParams>(
    ENDPOINTS.updateCustomerPhone,
    getDeps,
    async (scope) => {
      const id = customerIdParam(scope.params, scope.reply);
      if (!id.ok) return id.response;
      const body = await readJsonBody(scope, UpdatePhoneRequest);
      if (!body.ok) return body.response;

      const updated = await updateCustomerPhone.call(scope.deps.runtime, scope.ctx, {
        customerId: id.id,
        field: "phone",
        phone: body.value.phone,
      });
      if (!updated.ok) return customerErrorResponse(scope.reply, updated.error);
      const changed = updated.value.changed.includes("phone");

      const row = await getRosterCustomer.call(scope.deps.runtime, scope.ctx, {
        customerId: id.id,
      });
      if (!row.ok) return customerErrorResponse(scope.reply, row.error);
      scope.log.info("mobile_api.phone_updated", { changed });
      return scope.reply.ok({ changed, customer: rosterCustomerWire(row.value) });
    },
  );
}
