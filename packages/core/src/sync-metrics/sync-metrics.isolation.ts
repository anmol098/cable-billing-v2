/**
 * Tenant isolation cases for `sync_metrics.record_payment_batch` (T-086a, PLAN §9.1): tenant A
 * can't count tenant B's payments as its own accepted or duplicate payments (NOT_FOUND, nothing
 * written anywhere); with its own payment the same call succeeds. A rejected id is the phone's own
 * per-tenant key, so another tenant's id is just a new key there (tested in sync-metrics.test.ts).
 */
import { customers, uuidv7 } from "@cb/db";
import { postPaymentInTx } from "../payments/post-payment";
import { defineIsolationCases, type IsolationSeedArgs } from "../testing/isolation";
import { recordPaymentSyncBatch } from "./record";

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
    { operatorId: tenant.operatorId, userId: tenant.users.lineman, channel: "web", deviceId: null },
    { id: uuidv7(), customerId, amountPaise: 50_000, method: "cash" },
    new Date(),
  );
  if (!posted.ok) throw new Error(`seed payment: ${posted.error.code}`);
  return { paymentId: posted.value.payment.id };
}

export const recordPaymentSyncBatchIsolation = defineIsolationCases(recordPaymentSyncBatch, {
  seed: seedPayment,
  cases: [
    {
      name: "count another tenant's payment as posted",
      input: (seed) => ({ items: [{ outcome: "posted" as const, id: seed.paymentId }] }),
    },
    {
      name: "count another tenant's payment as a duplicate",
      input: (seed) => ({
        items: [
          { outcome: "duplicate" as const, id: seed.paymentId },
          { outcome: "rejected" as const, id: uuidv7(), code: "VALIDATION" as const },
        ],
      }),
    },
  ],
});
