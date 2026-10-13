/**
 * Tenant isolation cases for `receipts.record_action` (T-061, PLAN §9.1, RULE-22): tenant A
 * records an action on tenant B's payment and gets NOT_FOUND with nothing written; with its own
 * payment the same call succeeds. (The action id is the phone's own per-tenant key: another
 * tenant's action id is just a new id here, tested in `actions.test.ts`.)
 */
import { customers, uuidv7 } from "@cb/db";
import { postPaymentInTx } from "../../payments/post-payment";
import { defineIsolationCases, type IsolationSeedArgs } from "../../testing/isolation";
import { recordReceiptAction } from "./record";

async function seedPayment({ tx, tenant }: IsolationSeedArgs) {
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId: tenant.operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
  });
  const posted = await postPaymentInTx(
    tx,
    { operatorId: tenant.operatorId, userId: tenant.users.owner, channel: "web", deviceId: null },
    { id: uuidv7(), customerId, amountPaise: 50_000, method: "cash" },
    new Date(),
  );
  if (!posted.ok) throw new Error(`seed payment: ${posted.error.code}`);
  return { paymentId: posted.value.payment.id };
}

export const recordReceiptActionIsolation = defineIsolationCases(recordReceiptAction, {
  seed: seedPayment,
  cases: [
    {
      name: "record a printed receipt on another tenant's payment",
      input: (seed) => ({
        id: uuidv7(),
        paymentId: seed.paymentId,
        action: "printed" as const,
        at: "2026-10-13T05:30:00.000Z",
      }),
    },
  ],
});
