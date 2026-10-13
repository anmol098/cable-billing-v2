/**
 * Tenant isolation cases for the customer statement services (T-049, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: as tenant A with tenant B's customer id every call is NOT_FOUND
 * and nothing is written.
 */
import {
  customerBalances,
  customers,
  invoices,
  ledgerEntries,
  paymentReversals,
  payments,
  receipts,
  users,
  uuidv7,
} from "@cb/db";
import { businessDateOf, periodOfInstant } from "@cb/domain";
import { eq } from "drizzle-orm";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { customerBills } from "./bills";
import { customerStatement } from "./statement";

/** A customer with this month's bill, a cash payment and its undo (the harness's real clock). */
async function seedStatement({ tx, tenant }: IsolationSeedArgs) {
  const operatorId = tenant.operatorId;
  const now = new Date();
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
  });
  const invoiceId = uuidv7();
  await tx.insert(invoices).values({
    id: invoiceId,
    operatorId,
    customerId,
    period: periodOfInstant(now),
    invoiceNumber: `INV-ISO-${invoiceId.slice(-6)}`,
    openingBalancePaise: 0,
    chargesPaise: 30_000,
    totalDuePaise: 30_000,
  });
  const [owner] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.operatorId, operatorId))
    .limit(1);
  if (!owner) throw new Error("the seeded tenant has no user");
  const paymentId = uuidv7();
  await tx.insert(payments).values({
    id: paymentId,
    operatorId,
    customerId,
    amountPaise: 10_000,
    method: "cash",
    collectorId: owner.id,
    source: "web",
    recordedAt: now,
    businessDate: businessDateOf(now),
    balanceAfterPaise: 20_000,
    creditAfterPaise: 0,
  });
  await tx.insert(receipts).values({
    id: uuidv7(),
    operatorId,
    paymentId,
    receiptNumber: `R-ISO-${paymentId.slice(-6)}`,
  });
  const reversalId = uuidv7();
  await tx.insert(paymentReversals).values({
    id: reversalId,
    operatorId,
    customerId,
    paymentId,
    reason: "Isolation",
    actorId: owner.id,
  });
  await tx.insert(ledgerEntries).values([
    { id: uuidv7(), operatorId, customerId, type: "invoice", amountPaise: 30_000, invoiceId },
    { id: uuidv7(), operatorId, customerId, type: "payment", amountPaise: -10_000, paymentId },
    {
      id: uuidv7(),
      operatorId,
      customerId,
      type: "payment_reversal",
      amountPaise: 10_000,
      paymentReversalId: reversalId,
    },
  ]);
  await tx.insert(customerBalances).values({ customerId, operatorId, balancePaise: 30_000 });
  return { customerId };
}

export const customerStatementIsolation = defineIsolationCases(customerStatement, {
  seed: seedStatement,
  cases: [
    {
      name: "statement of another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId }),
    },
    {
      name: "statement of another tenant's customer for a date range",
      input: (seed) => {
        const today = businessDateOf(new Date());
        return { customerId: seed.customerId, from: today, to: today };
      },
    },
  ],
});

export const customerBillsIsolation = defineIsolationCases(customerBills, {
  seed: seedStatement,
  cases: [
    {
      name: "bills of another tenant's customer",
      input: (seed) => ({ customerId: seed.customerId }),
    },
  ],
});
