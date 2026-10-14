/**
 * The customer's Bills tab (T-049; PLAN §12.1 Customers → Bills; FR-011).
 *
 * `customerBills` (`statements.customer_bills`, capability `dashboard.view`: Owner and Staff;
 * READ ONLY, REPEATABLE READ): every bill of one customer, newest month first, with what is paid
 * on it (Σ its allocations, net of undone payments: reversal rows are negative) and what it still
 * owes (charges − paid, T-041 `invoiceOutstanding`), the same numbers as T-047's register and bill
 * page (`billPayState`). Plus the debit bill changes that wait for the next bill and the account
 * now. Each row links to T-047's bill page (`/bills/[id]`), which has the lines and payments.
 *
 * Σ outstanding of the bills − credit = the balance (`customer_balances`) once the books are
 * consistent (every unused credit is the customer's, every bill's due is the customer's); the
 * service tests check it on realistic data.
 *
 * Another tenant's customer id → NOT_FOUND.
 */
import { adjustments, allocations, customerBalances, customers, invoices } from "@cb/db";
import { err, ok, type Paise, toPaise, period as toPeriod } from "@cb/domain";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { billPayState } from "../billing/views";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import type { CustomerBillRow, CustomerBillsView } from "./types";

/** Bills returned at most (one a month: 100 years). */
export const CUSTOMER_BILLS_LIMIT = 1200;

export const CustomerBillsInput = z.object({
  customerId: z.uuid().transform((value) => value.toLowerCase()),
});

/** `statements.customer_bills`: one customer's bills with paid / still due. */
export const customerBills = defineService({
  name: "statements.customer_bills",
  capability: "dashboard.view",
  input: CustomerBillsInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx }) {
    const op = ctx.operatorId;
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.operatorId, op), eq(customers.id, input.customerId)));
    if (!customer) return err(notFound());

    const paid = tx
      .select({
        invoiceId: allocations.invoiceId,
        paid: sql<string>`sum(${allocations.amountPaise})`.as("paid"),
      })
      .from(allocations)
      .where(and(eq(allocations.operatorId, op), eq(allocations.customerId, customer.id)))
      .groupBy(allocations.invoiceId)
      .as("paid_per_invoice");
    const rows = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        period: invoices.period,
        kind: invoices.kind,
        status: invoices.status,
        issuedAt: invoices.issuedAt,
        chargesPaise: invoices.chargesPaise,
        paidPaise: sql<string>`coalesce(${paid.paid}, 0)::text`,
      })
      .from(invoices)
      .leftJoin(paid, eq(paid.invoiceId, invoices.id))
      .where(and(eq(invoices.operatorId, op), eq(invoices.customerId, customer.id)))
      .orderBy(desc(invoices.period), desc(invoices.issuedAt), desc(invoices.id))
      .limit(CUSTOMER_BILLS_LIMIT);

    const [pending] = await tx
      .select({ total: sql<string>`coalesce(sum(${adjustments.amountPaise}), 0)::text` })
      .from(adjustments)
      .where(
        and(
          eq(adjustments.operatorId, op),
          eq(adjustments.customerId, customer.id),
          eq(adjustments.direction, "debit"),
          isNull(adjustments.invoiceId),
        ),
      );
    const [balance] = await tx
      .select()
      .from(customerBalances)
      .where(
        and(eq(customerBalances.operatorId, op), eq(customerBalances.customerId, customer.id)),
      );

    let count = 0;
    let charges = 0;
    let paidTotal = 0;
    const bills = rows.map((row): CustomerBillRow => {
      const chargesPaise = toPaise(row.chargesPaise);
      const paidPaise = toPaise(row.paidPaise);
      if (row.status !== "void") {
        count += 1;
        charges += chargesPaise;
        paidTotal += paidPaise;
      }
      return {
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        period: toPeriod(row.period),
        kind: row.kind,
        status: row.status,
        issuedAt: row.issuedAt,
        chargesPaise,
        paidPaise,
        outstandingPaise: toPaise(chargesPaise - paidPaise),
        payState: billPayState(row.status, chargesPaise, paidPaise),
      };
    });
    const view: CustomerBillsView = {
      customerId: customer.id,
      rows: bills,
      totals: {
        count,
        chargesPaise: toPaise(charges),
        paidPaise: toPaise(paidTotal),
        outstandingPaise: toPaise(charges - paidTotal),
      },
      pendingChargesPaise: toPaise(pending?.total ?? 0) as Paise,
      balancePaise: toPaise(balance?.balancePaise ?? 0),
      creditPaise: toPaise(balance?.creditPaise ?? 0),
    };
    return ok(view);
  },
});
