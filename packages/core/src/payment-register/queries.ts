/**
 * The office's payment reads (T-048, PLAN §12.1 "Payments"; FR-013, BR-13): the payment register
 * with filters and totals, one payment's details, and the receipt of a payment (for the printable
 * A5 receipt). Capability `dashboard.view` (Owner, Staff; a read capability, so READ ONLY
 * transactions, allowed in read-only mode). Another tenant's ids (payment, customer, collector)
 * give NOT_FOUND, like made-up ids.
 *
 * Nothing here changes a row: posting and undoing are `payments.post` / `payments.reverse`
 * (T-046); the only write of this module is `payments.resolve_review` (./review.ts).
 */
import {
  allocations,
  customerBalances,
  customers,
  invoices,
  paymentReversals,
  payments,
  receipts,
  users,
} from "@cb/db";
import { type BusinessDate, err, ok, type Period, toPaise } from "@cb/domain";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { businessDateInput, idInput } from "../collections/inputs";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import { loadPublicReceipt, type PublicReceipt } from "../receipts/links/view";
import {
  PAYMENT_LIST_STATUSES,
  type PaymentCollectorOption,
  type PaymentDetail,
  type PaymentRegister,
  type PaymentRegisterRow,
} from "./types";

/** Rows per page by default, and at most. */
export const PAYMENT_PAGE_SIZE = 50;
export const MAX_PAYMENT_PAGE_SIZE = 100;
/** Deepest offset (narrow the dates instead). */
export const MAX_PAYMENT_OFFSET = 10_000;

export const ListPaymentsInput = z
  .object({
    /** First IST business date (inclusive). */
    from: businessDateInput.optional(),
    /** Last IST business date (inclusive). */
    to: businessDateInput.optional(),
    /** Who took the payment (a user of this business). */
    collectorId: idInput.optional(),
    method: z.enum(["cash", "upi"]).optional(),
    status: z.enum(PAYMENT_LIST_STATUSES).default("all"),
    /** One customer's payments (the customer's Payments tab). */
    customerId: idInput.optional(),
    /** A receipt number `R-…` or a phone's temporary number `P-…` (exact, any case). */
    receiptNumber: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .transform((value) => value.toUpperCase())
      .optional(),
    limit: z.number().int().min(1).max(MAX_PAYMENT_PAGE_SIZE).default(PAYMENT_PAGE_SIZE),
    offset: z.number().int().min(0).max(MAX_PAYMENT_OFFSET).default(0),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "The last day is before the first day",
    path: ["to"],
  });

export type ListPaymentsCommand = z.output<typeof ListPaymentsInput>;

const collectorUser = alias(users, "collector");

/** The WHERE of the register (shared by the page query and the totals). */
function registerFilter(operatorId: string, input: ListPaymentsCommand): SQL {
  const conditions: (SQL | undefined)[] = [eq(payments.operatorId, operatorId)];
  if (input.from) conditions.push(gte(payments.businessDate, input.from));
  if (input.to) conditions.push(lte(payments.businessDate, input.to));
  if (input.collectorId) conditions.push(eq(payments.collectorId, input.collectorId));
  if (input.method) conditions.push(eq(payments.method, input.method));
  if (input.customerId) conditions.push(eq(payments.customerId, input.customerId));
  if (input.receiptNumber) {
    conditions.push(
      or(
        sql`upper(${receipts.receiptNumber}) = ${input.receiptNumber}`,
        eq(receipts.provisionalRef, input.receiptNumber),
      ),
    );
  }
  if (input.status === "counted") conditions.push(isNull(paymentReversals.id));
  if (input.status === "cancelled") conditions.push(isNotNull(paymentReversals.id));
  if (input.status === "to_check") conditions.push(eq(payments.reviewStatus, "needs_review"));
  return and(...conditions) as SQL;
}

const receiptJoin = and(
  eq(receipts.operatorId, payments.operatorId),
  eq(receipts.paymentId, payments.id),
);
const reversalJoin = and(
  eq(paymentReversals.operatorId, payments.operatorId),
  eq(paymentReversals.paymentId, payments.id),
);

export const listPayments = defineService({
  name: "payments.list",
  capability: "dashboard.view",
  input: ListPaymentsInput,
  async run({ ctx, input, tx }) {
    const op = ctx.operatorId;
    if (input.collectorId) {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.operatorId, op), eq(users.id, input.collectorId)));
      if (!user) return err(notFound());
    }
    if (input.customerId) {
      const [customer] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.operatorId, op), eq(customers.id, input.customerId)));
      if (!customer) return err(notFound());
    }
    const where = registerFilter(op, input);

    const found = await tx
      .select({
        id: payments.id,
        customerId: payments.customerId,
        customerCode: customers.customerCode,
        customerName: customers.name,
        amountPaise: payments.amountPaise,
        method: payments.method,
        source: payments.source,
        collectorId: payments.collectorId,
        collectorName: collectorUser.name,
        recordedAt: payments.recordedAt,
        postedAt: payments.postedAt,
        businessDate: payments.businessDate,
        receiptNumber: receipts.receiptNumber,
        provisionalRef: receipts.provisionalRef,
        reviewStatus: payments.reviewStatus,
        reviewReason: payments.reviewReason,
        reversalId: paymentReversals.id,
      })
      .from(payments)
      .innerJoin(
        customers,
        and(eq(customers.operatorId, payments.operatorId), eq(customers.id, payments.customerId)),
      )
      .leftJoin(receipts, receiptJoin)
      .leftJoin(paymentReversals, reversalJoin)
      .leftJoin(
        collectorUser,
        and(
          eq(collectorUser.operatorId, payments.operatorId),
          eq(collectorUser.id, payments.collectorId),
        ),
      )
      .where(where)
      .orderBy(desc(payments.postedAt), desc(payments.id))
      .limit(input.limit + 1)
      .offset(input.offset);

    const [totals] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        cashPaise: sql<string>`coalesce(sum(${payments.amountPaise}) FILTER (WHERE ${payments.method} = 'cash' AND ${paymentReversals.id} IS NULL), 0)::text`,
        upiPaise: sql<string>`coalesce(sum(${payments.amountPaise}) FILTER (WHERE ${payments.method} = 'upi' AND ${paymentReversals.id} IS NULL), 0)::text`,
        cancelledCount: sql<number>`(count(*) FILTER (WHERE ${paymentReversals.id} IS NOT NULL))::int`,
        toCheckCount: sql<number>`(count(*) FILTER (WHERE ${payments.reviewStatus} = 'needs_review'))::int`,
      })
      .from(payments)
      .leftJoin(receipts, receiptJoin)
      .leftJoin(paymentReversals, reversalJoin)
      .where(where);

    const collectors = await tx
      .select({ id: users.id, name: users.name, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.operatorId, op))
      .orderBy(asc(users.name), asc(users.id));

    const rows: PaymentRegisterRow[] = found.slice(0, input.limit).map((row) => ({
      id: row.id,
      customerId: row.customerId,
      customerCode: row.customerCode,
      customerName: row.customerName,
      amountPaise: toPaise(row.amountPaise),
      method: row.method,
      source: row.source,
      collectorId: row.collectorId,
      collectorName: row.collectorName,
      recordedAt: row.recordedAt,
      postedAt: row.postedAt,
      businessDate: row.businessDate as BusinessDate,
      receiptNumber: row.receiptNumber,
      provisionalRef: row.provisionalRef,
      reviewStatus: row.reviewStatus,
      reviewReason: row.reviewReason,
      cancelled: row.reversalId !== null,
    }));
    const value: PaymentRegister = {
      rows,
      hasMore: found.length > input.limit,
      totals: {
        count: Number(totals?.count ?? 0),
        cashPaise: toPaise(totals?.cashPaise ?? "0"),
        upiPaise: toPaise(totals?.upiPaise ?? "0"),
        cancelledCount: Number(totals?.cancelledCount ?? 0),
        toCheckCount: Number(totals?.toCheckCount ?? 0),
      },
      collectors: collectors.map(
        (user): PaymentCollectorOption => ({
          id: user.id,
          name: user.name,
          role: user.role,
          active: user.status === "active",
        }),
      ),
    };
    return ok(value);
  },
});

// ---------------------------------------------------------------------------------------------

export const GetPaymentInput = z.object({ paymentId: idInput });

const reviewer = alias(users, "reviewer");
const reverser = alias(users, "reverser");

export const getPayment = defineService({
  name: "payments.get",
  capability: "dashboard.view",
  input: GetPaymentInput,
  async run({ ctx, input, tx }) {
    const op = ctx.operatorId;
    const [row] = await tx
      .select({
        payment: payments,
        customerCode: customers.customerCode,
        customerName: customers.name,
        customerPhone: customers.phone,
        balancePaise: customerBalances.balancePaise,
        creditPaise: customerBalances.creditPaise,
        collectorName: collectorUser.name,
        reviewerName: reviewer.name,
        receiptId: receipts.id,
        receiptNumber: receipts.receiptNumber,
        provisionalRef: receipts.provisionalRef,
        issuedAt: receipts.issuedAt,
        reversalId: paymentReversals.id,
        reversalReason: paymentReversals.reason,
        reversalActorId: paymentReversals.actorId,
        reversalAt: paymentReversals.at,
        reverserName: reverser.name,
      })
      .from(payments)
      .innerJoin(
        customers,
        and(eq(customers.operatorId, payments.operatorId), eq(customers.id, payments.customerId)),
      )
      .leftJoin(
        customerBalances,
        and(
          eq(customerBalances.operatorId, payments.operatorId),
          eq(customerBalances.customerId, payments.customerId),
        ),
      )
      .leftJoin(receipts, receiptJoin)
      .leftJoin(paymentReversals, reversalJoin)
      .leftJoin(
        collectorUser,
        and(
          eq(collectorUser.operatorId, payments.operatorId),
          eq(collectorUser.id, payments.collectorId),
        ),
      )
      .leftJoin(
        reviewer,
        and(eq(reviewer.operatorId, payments.operatorId), eq(reviewer.id, payments.reviewedBy)),
      )
      .leftJoin(
        reverser,
        and(
          eq(reverser.operatorId, paymentReversals.operatorId),
          eq(reverser.id, paymentReversals.actorId),
        ),
      )
      .where(and(eq(payments.operatorId, op), eq(payments.id, input.paymentId)));
    if (!row) return err(notFound());
    const p = row.payment;

    const bills = await tx
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        invoiceKind: invoices.kind,
        period: invoices.period,
        amountPaise: allocations.amountPaise,
        outstandingAfterPaise: allocations.outstandingAfterPaise,
      })
      .from(allocations)
      .innerJoin(
        invoices,
        and(
          eq(invoices.operatorId, allocations.operatorId),
          eq(invoices.id, allocations.invoiceId),
        ),
      )
      .where(
        and(
          eq(allocations.operatorId, op),
          eq(allocations.paymentId, p.id),
          eq(allocations.kind, "posting"),
        ),
      )
      .orderBy(asc(invoices.period), asc(invoices.id));
    const allocated = bills.reduce((sum, bill) => sum + BigInt(bill.amountPaise), 0n);

    const detail: PaymentDetail = {
      id: p.id,
      amountPaise: toPaise(p.amountPaise),
      method: p.method,
      upiReference: p.upiReference,
      notes: p.notes,
      source: p.source,
      recordedAt: p.recordedAt,
      postedAt: p.postedAt,
      businessDate: p.businessDate as BusinessDate,
      customer: {
        id: p.customerId,
        code: row.customerCode,
        name: row.customerName,
        phone: row.customerPhone,
        balancePaise: toPaise(row.balancePaise ?? 0),
        creditPaise: toPaise(row.creditPaise ?? 0),
      },
      collector:
        p.collectorId && row.collectorName !== null
          ? { id: p.collectorId, name: row.collectorName }
          : null,
      receipt:
        row.receiptId && row.receiptNumber && row.issuedAt
          ? {
              id: row.receiptId,
              receiptNumber: row.receiptNumber,
              provisionalRef: row.provisionalRef,
              issuedAt: row.issuedAt,
            }
          : null,
      bills: bills.map((bill) => ({
        invoiceId: bill.invoiceId,
        invoiceNumber: bill.invoiceNumber,
        invoiceKind: bill.invoiceKind,
        period: bill.period as Period,
        amountPaise: toPaise(bill.amountPaise),
        outstandingAfterPaise: toPaise(bill.outstandingAfterPaise),
      })),
      creditAddedPaise: toPaise(BigInt(p.amountPaise) - allocated),
      balanceAfterPaise: p.balanceAfterPaise === null ? null : toPaise(p.balanceAfterPaise),
      creditAfterPaise: p.creditAfterPaise === null ? null : toPaise(p.creditAfterPaise),
      review: {
        status: p.reviewStatus,
        reason: p.reviewReason,
        reviewedBy:
          p.reviewedBy && row.reviewerName !== null
            ? { id: p.reviewedBy, name: row.reviewerName }
            : null,
        reviewedAt: p.reviewedAt,
        note: p.reviewNote,
      },
      cancellation:
        row.reversalId && row.reversalReason !== null && row.reversalAt && row.reversalActorId
          ? {
              id: row.reversalId,
              reason: row.reversalReason,
              by: { id: row.reversalActorId, name: row.reverserName ?? "" },
              at: row.reversalAt,
            }
          : null,
    };
    return ok(detail);
  },
});

// ---------------------------------------------------------------------------------------------

export const GetPaymentReceiptInput = z.object({ paymentId: idInput });

/**
 * The receipt of a payment as the customer's receipt shows it (T-050's `PublicReceipt`: first name
 * + masked phone, no UPI ref, notes or lineman): the web prints it as an A5 page.
 */
export const getPaymentReceipt = defineService({
  name: "payments.receipt",
  capability: "dashboard.view",
  input: GetPaymentReceiptInput,
  async run({ ctx, input, tx }) {
    const [receipt] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.operatorId, ctx.operatorId), eq(receipts.paymentId, input.paymentId)));
    if (!receipt) return err(notFound());
    const view: PublicReceipt | null = await loadPublicReceipt(tx, ctx.operatorId, receipt.id);
    if (!view) return err(notFound());
    return ok(view);
  },
});
