/**
 * Isolation seed shared by the T-080 report cases: an area, a customer in it with this month's
 * bill posted to the ledger (so the customer owes money and the bill is listed). Not exported
 * from the package.
 */
import { areas, customers, invoices, ledgerEntries, uuidv7 } from "@cb/db";
import { periodOfInstant } from "@cb/domain";
import type { IsolationSeedArgs } from "../../testing/isolation";

/** The current IST month (the harness runs on the real clock). */
export const thisPeriod = () => periodOfInstant(new Date());

export async function seedOwingCustomer({ tx, tenant }: IsolationSeedArgs) {
  const operatorId = tenant.operatorId;
  const areaId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId, name: "North" });
  const customerId = uuidv7();
  await tx.insert(customers).values({
    id: customerId,
    operatorId,
    customerCode: `ISO-${customerId.slice(-6)}`,
    name: "Isolation customer",
    areaId,
  });
  const invoiceId = uuidv7();
  // A minute ago, so the report (as of the harness' real clock) includes it.
  const issuedAt = new Date(Date.now() - 60_000);
  await tx.insert(invoices).values({
    id: invoiceId,
    operatorId,
    customerId,
    period: thisPeriod(),
    invoiceNumber: `INV-ISO-${invoiceId.slice(-6)}`,
    openingBalancePaise: 0,
    chargesPaise: 30_000,
    totalDuePaise: 30_000,
    issuedAt,
  });
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId,
    customerId,
    type: "invoice",
    amountPaise: 30_000,
    invoiceId,
    at: issuedAt,
  });
  return { areaId, customerId, invoiceId };
}
