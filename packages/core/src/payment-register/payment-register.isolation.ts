/**
 * Tenant isolation cases for the office payment pages (T-048, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: as tenant A with tenant B's ids every call is NOT_FOUND with
 * nothing written; the register never lists B's payments.
 */
import { customers, uuidv7 } from "@cb/db";
import { postPaymentInTx } from "../payments/post-payment";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { getPayment, getPaymentReceipt, listPayments } from "./queries";
import { resolvePaymentReview } from "./review";

/**
 * One customer (inactive, so the payment is flagged `customer_inactive`) and one counter payment
 * taken by the tenant's owner.
 */
async function seedPayment({ tx, tenant }: IsolationSeedArgs) {
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId: tenant.operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
    status: "inactive",
  });
  const posted = await postPaymentInTx(
    tx,
    { operatorId: tenant.operatorId, userId: tenant.users.owner, channel: "web", deviceId: null },
    { id: uuidv7(), customerId, amountPaise: 50_000, method: "cash" },
    new Date(),
  );
  if (!posted.ok) throw new Error(`seed payment: ${posted.error.code}`);
  return {
    customerId,
    paymentId: posted.value.payment.id,
    receiptNumber: posted.value.receipt.receiptNumber,
    collectorId: tenant.users.owner,
  };
}

export const listPaymentsIsolation = defineIsolationCases(listPayments, {
  seed: seedPayment,
  cases: [
    { name: "payment register", expect: "no_leak", input: () => ({}) },
    {
      name: "payments to check",
      expect: "no_leak",
      input: () => ({ status: "to_check" as const }),
    },
    {
      name: "register by receipt number (both tenants' first receipt has the same number)",
      expect: "no_leak",
      input: (seed) => ({ receiptNumber: seed.receiptNumber }),
    },
    {
      name: "another tenant's customer's payments",
      input: (seed) => ({ customerId: seed.customerId }),
    },
    {
      name: "payments taken by another tenant's user",
      input: (seed) => ({ collectorId: seed.collectorId }),
    },
  ],
});

export const getPaymentIsolation = defineIsolationCases(getPayment, {
  seed: seedPayment,
  cases: [
    { name: "open another tenant's payment", input: (seed) => ({ paymentId: seed.paymentId }) },
  ],
});

export const getPaymentReceiptIsolation = defineIsolationCases(getPaymentReceipt, {
  seed: seedPayment,
  cases: [
    { name: "print another tenant's receipt", input: (seed) => ({ paymentId: seed.paymentId }) },
  ],
});

export const resolvePaymentReviewIsolation = defineIsolationCases(resolvePaymentReview, {
  seed: seedPayment,
  cases: [
    {
      name: "mark another tenant's flagged payment as checked",
      input: (seed) => ({ paymentId: seed.paymentId, note: "Looked at it" }),
    },
  ],
});
