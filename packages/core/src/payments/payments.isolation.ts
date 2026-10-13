/**
 * Tenant isolation cases for the payment services (T-046, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts. Each case calls the service as tenant A with tenant B's ids:
 * NOT_FOUND, nothing written anywhere (no balance row, no counter step, no session).
 */
import { customers, uuidv7 } from "@cb/db";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { postPayment, postPaymentInTx } from "./post-payment";
import { reversePayment } from "./reverse-payment";

async function seedCustomer({ tx, tenant }: IsolationSeedArgs) {
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId: tenant.operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
  });
  return { customerId };
}

async function seedPayment(args: IsolationSeedArgs) {
  const { customerId } = await seedCustomer(args);
  const posted = await postPaymentInTx(
    args.tx,
    {
      operatorId: args.tenant.operatorId,
      userId: args.tenant.users.owner,
      channel: "web",
      deviceId: null,
    },
    { id: uuidv7(), customerId, amountPaise: 50_000, method: "cash" },
    new Date(),
  );
  if (!posted.ok) throw new Error(`seed payment: ${posted.error.code}`);
  return { customerId, paymentId: posted.value.payment.id };
}

export const postPaymentIsolation = defineIsolationCases(postPayment, {
  seed: seedCustomer,
  cases: [
    {
      name: "post a payment for another tenant's customer",
      // A fresh payment id per call; mobile callers (lineman) send the device fields too.
      input: (seed, tenant) => ({
        id: uuidv7(),
        customerId: seed.customerId,
        amountPaise: 50_000,
        method: "cash" as const,
        recordedAt: new Date(),
        provisionalRef: "P-ISO-0001",
        claimedCollectorId: tenant.users.lineman,
      }),
      roles: ["owner", "staff"],
    },
    {
      name: "post a field payment for another tenant's customer",
      input: (seed, tenant) => ({
        id: uuidv7(),
        customerId: seed.customerId,
        amountPaise: 50_000,
        method: "upi" as const,
        upiReference: "123456789012",
        recordedAt: new Date(),
        provisionalRef: "P-ISO-0002",
        claimedCollectorId: tenant.users.lineman,
        claimedDeviceId: tenant.deviceId,
      }),
      roles: ["lineman"],
    },
  ],
});

export const reversePaymentIsolation = defineIsolationCases(reversePayment, {
  seed: seedPayment,
  cases: [
    {
      name: "reverse another tenant's payment",
      input: (seed) => ({ paymentId: seed.paymentId, reason: "Entered twice" }),
    },
  ],
});
