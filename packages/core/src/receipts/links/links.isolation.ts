/**
 * Tenant isolation cases for the receipt link services (T-050, PLAN §9.1, RULE-22). Run by
 * src/testing/isolation.test.ts: tenant A asks for (or revokes) a link of tenant B's payment and
 * gets NOT_FOUND with nothing written; with its own payment the same call succeeds.
 *
 * The public side (`openReceiptLink`, token only, no tenant context) has its own cross-tenant test
 * in `links.test.ts`.
 */
import { customers, uuidv7 } from "@cb/db";
import { postPaymentInTx } from "../../payments/post-payment";
import { defineIsolationCases, type IsolationSeedArgs } from "../../testing/isolation";
import { createReceiptLink, revokeReceiptLinks } from "./manage";

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

export const createReceiptLinkIsolation = defineIsolationCases(createReceiptLink, {
  seed: seedPayment,
  cases: [
    {
      name: "make a preview link for another tenant's payment",
      input: (seed) => ({ paymentId: seed.paymentId }),
    },
  ],
});

export const revokeReceiptLinksIsolation = defineIsolationCases(revokeReceiptLinks, {
  seed: seedPayment,
  cases: [
    {
      name: "switch off the preview links of another tenant's payment",
      input: (seed) => ({ paymentId: seed.paymentId }),
    },
  ],
});
