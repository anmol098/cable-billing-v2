/**
 * Bills read services (T-047; PLAN §12.1 "Bills"; J-03; FR-009, FR-011). Everything the Bills pages
 * show that T-044's run services don't: the month calendar, a run's problem list with names, the
 * bill register and one bill with its lines, bill changes and payments. Read only (`billing.preview`:
 * Owner and Staff; READ ONLY transactions; allowed in read-only mode). Another tenant's ids give
 * NOT_FOUND (RLS hides the rows).
 *
 * | Service | Input | What |
 * |---|---|---|
 * | `billingMonths` (`billing.months`) | `{ from, to }` (≤ 24 months) | Run and bill totals per month. |
 * | `billingRunProblems` (`billing.run_problems`) | `{ runId }` | The run and its failed items, with names. |
 * | `billingCustomerLabels` (`billing.customer_labels`) | `{ customerIds }` (≤ 500) | Code, name, area (preview problems). |
 * | `listBills` (`billing.list_bills`) | `{ period, areaId?, payState?, page? }` | The bill register. |
 * | `getBill` (`billing.get_bill`) | `{ invoiceId }` | One bill: lines per VC, bill changes, payments, balance. |
 *
 * What a bill still owes is `charges − Σ its allocations` (T-041 `invoiceOutstanding`); allocation
 * rows of an undone payment are negative, so the sum is already net.
 */
import {
  adjustments,
  allocations,
  areas,
  billingRunItems,
  billingRuns,
  customerBalances,
  customers,
  invoiceLines,
  invoices,
  operators,
  parseOperatorSettings,
  paymentReversals,
  payments,
  receipts,
  type Tx,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import {
  err,
  monthsBetween,
  ok,
  type Period,
  periodOfInstant,
  periodsBetween,
  toPaise,
  period as toPeriod,
} from "@cb/domain";
import { and, asc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { readTenantMode } from "../authz/writable";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import { toRunView } from "./runs";
import { BillingPeriodInput } from "./services";
import {
  type BillAdjustmentView,
  type BillConnectionView,
  type BillCustomerLabel,
  type BillDetailView,
  type BillingMonth,
  type BillingMonthsView,
  type BillingRunProblemsView,
  type BillLineView,
  BILL_PAY_STATES,
  type BillPayState,
  type BillPaymentView,
  type BillRegisterView,
  type BillRow,
} from "./view-types";

/** Months the calendar may ask for at once. */
export const BILLING_MONTHS_MAX = 24;
/** Failed items returned by `billingRunProblems`. */
export const RUN_PROBLEMS_LIMIT = 500;
/** Customers `billingCustomerLabels` names at once (the preview reads 500 per page). */
export const CUSTOMER_LABELS_LIMIT = 500;
/** Rows per page of the bill register. */
export const BILL_REGISTER_PAGE_SIZE = 50;

const uuid = z.uuid().transform((value) => value.toLowerCase());

export const BillingMonthsInput = z
  .object({ from: BillingPeriodInput, to: BillingPeriodInput })
  .superRefine((value, ctx) => {
    const span = monthsBetween(value.from, value.to);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "to is before from" });
    else if (span >= BILLING_MONTHS_MAX) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "too many months" });
    }
  });
export const BillingRunProblemsInput = z.object({ runId: uuid });
export const BillingCustomerLabelsInput = z.object({
  customerIds: z.array(uuid).min(1).max(CUSTOMER_LABELS_LIMIT),
});
export const ListBillsInput = z.object({
  period: BillingPeriodInput,
  areaId: uuid.optional(),
  payState: z.enum(BILL_PAY_STATES).optional(),
  page: z.int().min(1).max(10_000).default(1),
});
export const GetBillInput = z.object({ invoiceId: uuid });

const dateOf = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** The pay state of a bill from its status, charges and what was applied to it. */
export function billPayState(
  status: "issued" | "void",
  chargesPaise: number,
  paidPaise: number,
): BillPayState {
  if (status === "void") return "void";
  if (chargesPaise === 0) return "no_charge";
  if (paidPaise >= chargesPaise) return "paid";
  return paidPaise > 0 ? "part_paid" : "unpaid";
}

/** `billing.months`: the Bills calendar (run status and bill totals per month). */
export const billingMonths = defineService({
  name: "billing.months",
  capability: "billing.preview",
  input: BillingMonthsInput,
  async run({ ctx, input, tx, now }) {
    const { operatorId } = ctx;
    const runRows = await tx
      .select()
      .from(billingRuns)
      .where(
        and(
          eq(billingRuns.operatorId, operatorId),
          gte(billingRuns.period, input.from),
          lte(billingRuns.period, input.to),
        ),
      );
    const runs = new Map(runRows.map((row) => [row.period, toRunView(row)]));
    const totals = await tx
      .select({
        period: invoices.period,
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${invoices.chargesPaise}), 0)::text`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.operatorId, operatorId),
          eq(invoices.kind, "regular"),
          eq(invoices.status, "issued"),
          gte(invoices.period, input.from),
          lte(invoices.period, input.to),
        ),
      )
      .groupBy(invoices.period);
    const billed = new Map(totals.map((row) => [row.period, row]));
    const [operator] = await tx
      .select({ createdAt: operators.createdAt })
      .from(operators)
      .where(eq(operators.id, operatorId));
    const months: BillingMonth[] = periodsBetween(input.from, input.to).map((p) => {
      const bills = billed.get(p);
      return {
        period: p,
        run: runs.get(p) ?? null,
        billCount: bills?.count ?? 0,
        billTotalPaise: toPaise(bills?.total ?? "0"),
      };
    });
    const view: BillingMonthsView = {
      currentPeriod: periodOfInstant(now),
      firstPeriod: periodOfInstant(operator?.createdAt ?? now),
      tenantMode: await readTenantMode(tx),
      months,
    };
    return ok(view);
  },
});

/** `billing.run_problems`: the run and its failed items, with the customers' names. */
export const billingRunProblems = defineService({
  name: "billing.run_problems",
  capability: "billing.preview",
  input: BillingRunProblemsInput,
  async run({ ctx, input, tx }) {
    const { operatorId } = ctx;
    const [run] = await tx
      .select()
      .from(billingRuns)
      .where(and(eq(billingRuns.operatorId, operatorId), eq(billingRuns.id, input.runId)));
    if (!run) return err(notFound());
    const failed = and(
      eq(billingRunItems.operatorId, operatorId),
      eq(billingRunItems.runId, run.id),
      eq(billingRunItems.outcome, "failed"),
    );
    const [counted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(billingRunItems)
      .where(failed);
    const rows = await tx
      .select({
        customerId: customers.id,
        code: customers.customerCode,
        name: customers.name,
        areaName: areas.name,
        reason: billingRunItems.reason,
        details: billingRunItems.details,
        attempts: billingRunItems.attempts,
        updatedAt: billingRunItems.updatedAt,
      })
      .from(billingRunItems)
      .innerJoin(
        customers,
        and(
          eq(customers.operatorId, billingRunItems.operatorId),
          eq(customers.id, billingRunItems.customerId),
        ),
      )
      .leftJoin(areas, and(eq(areas.operatorId, customers.operatorId), eq(areas.id, customers.areaId)))
      .where(failed)
      .orderBy(asc(customers.customerCode), asc(customers.id))
      .limit(RUN_PROBLEMS_LIMIT);
    const view: BillingRunProblemsView = {
      run: toRunView(run),
      failedCount: counted?.n ?? 0,
      problems: rows.map((row) => ({
        customer: { id: row.customerId, code: row.code, name: row.name, areaName: row.areaName },
        reason: row.reason ?? "internal_error",
        details: row.details,
        attempts: row.attempts,
        lastTriedAt: row.updatedAt,
      })),
    };
    return ok(view);
  },
});

/**
 * `billing.customer_labels`: code, name and area of the customers a preview names (its problems
 * carry ids only). NOT_FOUND when any id is not the tenant's customer.
 */
export const billingCustomerLabels = defineService({
  name: "billing.customer_labels",
  capability: "billing.preview",
  input: BillingCustomerLabelsInput,
  async run({ ctx, input, tx }) {
    const ids = [...new Set(input.customerIds)];
    const rows = await tx
      .select({
        id: customers.id,
        code: customers.customerCode,
        name: customers.name,
        areaName: areas.name,
      })
      .from(customers)
      .leftJoin(areas, and(eq(areas.operatorId, customers.operatorId), eq(areas.id, customers.areaId)))
      .where(and(eq(customers.operatorId, ctx.operatorId), inArray(customers.id, ids)))
      .orderBy(asc(customers.customerCode), asc(customers.id));
    if (rows.length !== ids.length) return err(notFound());
    const labels: BillCustomerLabel[] = rows;
    return ok(labels);
  },
});

/** Σ allocations per bill of the month (net: undone payments' rows are negative). */
function paidPerInvoice(tx: Tx, operatorId: string, period: Period) {
  const billsOfMonth = tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.operatorId, operatorId), eq(invoices.period, period)));
  return tx
    .select({
      invoiceId: allocations.invoiceId,
      paid: sql<string>`sum(${allocations.amountPaise})`.as("paid"),
    })
    .from(allocations)
    .where(
      and(eq(allocations.operatorId, operatorId), inArray(allocations.invoiceId, billsOfMonth)),
    )
    .groupBy(allocations.invoiceId)
    .as("paid_per_invoice");
}

/** `billing.list_bills`: the bill register of one month (filters: area, pay state). */
export const listBills = defineService({
  name: "billing.list_bills",
  capability: "billing.preview",
  input: ListBillsInput,
  async run({ ctx, input, tx }) {
    const { operatorId } = ctx;
    const areaRows = await tx
      .select({ id: areas.id, name: areas.name })
      .from(areas)
      .where(eq(areas.operatorId, operatorId))
      .orderBy(asc(areas.name), asc(areas.id));
    if (input.areaId !== undefined && !areaRows.some((area) => area.id === input.areaId)) {
      return err(notFound());
    }
    const paid = paidPerInvoice(tx, operatorId, input.period);
    const paidPaise = sql<string>`coalesce(${paid.paid}, 0)`;
    const state = sql<BillPayState>`CASE
      WHEN ${invoices.status} = 'void' THEN 'void'
      WHEN ${invoices.chargesPaise} = 0 THEN 'no_charge'
      WHEN ${paidPaise} >= ${invoices.chargesPaise} THEN 'paid'
      WHEN ${paidPaise} > 0 THEN 'part_paid'
      ELSE 'unpaid' END`;
    const filters: SQL[] = [eq(invoices.operatorId, operatorId), eq(invoices.period, input.period)];
    if (input.areaId !== undefined) filters.push(eq(customers.areaId, input.areaId));
    if (input.payState !== undefined) filters.push(sql`${state} = ${input.payState}`);
    const where = and(...filters);
    const [totals] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        charges: sql<string>`coalesce(sum(${invoices.chargesPaise}), 0)::text`,
        paid: sql<string>`coalesce(sum(${paidPaise}), 0)::text`,
      })
      .from(invoices)
      .innerJoin(
        customers,
        and(eq(customers.operatorId, invoices.operatorId), eq(customers.id, invoices.customerId)),
      )
      .leftJoin(paid, eq(paid.invoiceId, invoices.id))
      .where(where);
    const pageSize = BILL_REGISTER_PAGE_SIZE;
    const rows = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        period: invoices.period,
        kind: invoices.kind,
        status: invoices.status,
        chargesPaise: invoices.chargesPaise,
        paidPaise: sql<string>`${paidPaise}::text`,
        customerId: customers.id,
        code: customers.customerCode,
        name: customers.name,
        areaName: areas.name,
      })
      .from(invoices)
      .innerJoin(
        customers,
        and(eq(customers.operatorId, invoices.operatorId), eq(customers.id, invoices.customerId)),
      )
      .leftJoin(areas, and(eq(areas.operatorId, customers.operatorId), eq(areas.id, customers.areaId)))
      .leftJoin(paid, eq(paid.invoiceId, invoices.id))
      .where(where)
      .orderBy(asc(customers.customerCode), asc(invoices.invoiceNumber), asc(invoices.id))
      .limit(pageSize)
      .offset((input.page - 1) * pageSize);

    const chargesTotal = toPaise(totals?.charges ?? "0");
    const paidTotal = toPaise(totals?.paid ?? "0");
    const view: BillRegisterView = {
      period: input.period,
      areas: areaRows,
      page: input.page,
      pageSize,
      totals: {
        count: totals?.count ?? 0,
        chargesPaise: chargesTotal,
        paidPaise: paidTotal,
        outstandingPaise: toPaise(chargesTotal - paidTotal),
      },
      rows: rows.map((row): BillRow => {
        const charges = toPaise(row.chargesPaise);
        const paidOn = toPaise(row.paidPaise);
        return {
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          period: toPeriod(row.period),
          kind: row.kind,
          status: row.status,
          customer: { id: row.customerId, code: row.code, name: row.name, areaName: row.areaName },
          chargesPaise: charges,
          paidPaise: paidOn,
          outstandingPaise: toPaise(charges - paidOn),
          payState: billPayState(row.status, charges, paidOn),
        };
      }),
    };
    return ok(view);
  },
});

type AdjustmentRow = typeof adjustments.$inferSelect;

function adjustmentView(row: AdjustmentRow): BillAdjustmentView {
  return {
    id: row.id,
    source: row.source,
    direction: row.direction,
    period: row.period === null ? null : toPeriod(row.period),
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

/** `billing.get_bill`: one bill with its lines per VC, bill changes, payments and the balance now. */
export const getBill = defineService({
  name: "billing.get_bill",
  capability: "billing.preview",
  input: GetBillInput,
  async run({ ctx, input, tx }) {
    const { operatorId } = ctx;
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.operatorId, operatorId), eq(invoices.id, input.invoiceId)));
    if (!invoice) return err(notFound());

    const [customer] = await tx
      .select({
        id: customers.id,
        code: customers.customerCode,
        name: customers.name,
        areaName: areas.name,
        phone: customers.phone,
        address: customers.address,
      })
      .from(customers)
      .leftJoin(areas, and(eq(areas.operatorId, customers.operatorId), eq(areas.id, customers.areaId)))
      .where(and(eq(customers.operatorId, operatorId), eq(customers.id, invoice.customerId)));
    const [operator] = await tx.select().from(operators).where(eq(operators.id, operatorId));
    if (!customer || !operator) return err(notFound());
    const settings = parseOperatorSettings(operator.settings);

    // Lines, with the connection they are for (rent: the line's; bill change: the adjustment's).
    const lineRows = await tx
      .select({ line: invoiceLines, adjustment: adjustments })
      .from(invoiceLines)
      .leftJoin(
        adjustments,
        and(
          eq(adjustments.operatorId, invoiceLines.operatorId),
          eq(adjustments.id, invoiceLines.adjustmentId),
        ),
      )
      .where(and(eq(invoiceLines.operatorId, operatorId), eq(invoiceLines.invoiceId, invoice.id)))
      .orderBy(asc(invoiceLines.createdAt), asc(invoiceLines.id));
    const assignmentIds = [
      ...new Set(
        lineRows
          .map((row) => row.line.assignmentId ?? row.adjustment?.assignmentId ?? null)
          .filter((id): id is string => id !== null),
      ),
    ];
    const vcNumbers = new Map<string, string>();
    if (assignmentIds.length > 0) {
      for (const row of await tx
        .select({ id: vcAssignments.id, vcNumber: vcAssets.vcNumber })
        .from(vcAssignments)
        .innerJoin(
          vcAssets,
          and(
            eq(vcAssets.operatorId, vcAssignments.operatorId),
            eq(vcAssets.id, vcAssignments.vcAssetId),
          ),
        )
        .where(
          and(eq(vcAssignments.operatorId, operatorId), inArray(vcAssignments.id, assignmentIds)),
        )) {
        vcNumbers.set(row.id, row.vcNumber);
      }
    }
    const connections = new Map<string, { vcNumber: string; lines: BillLineView[] }>();
    const otherLines: BillLineView[] = [];
    for (const { line, adjustment } of lineRows) {
      const view: BillLineView = {
        id: line.id,
        type: line.type,
        amountPaise: toPaise(line.amountPaise),
        adjustment: adjustment ? adjustmentView(adjustment) : null,
        description: line.description,
      };
      const assignmentId = line.assignmentId ?? adjustment?.assignmentId ?? null;
      if (assignmentId === null) {
        otherLines.push(view);
        continue;
      }
      const group = connections.get(assignmentId) ?? {
        vcNumber: vcNumbers.get(assignmentId) ?? "",
        lines: [],
      };
      group.lines.push(view);
      connections.set(assignmentId, group);
    }

    // Payments and credit applied to this bill, one entry per source.
    const allocationRows = await tx
      .select({
        allocation: allocations,
        payment: {
          method: payments.method,
          amountPaise: payments.amountPaise,
          recordedAt: payments.recordedAt,
        },
        receiptNumber: receipts.receiptNumber,
        reversalId: paymentReversals.id,
        credit: adjustments,
      })
      .from(allocations)
      .leftJoin(
        payments,
        and(eq(payments.operatorId, allocations.operatorId), eq(payments.id, allocations.paymentId)),
      )
      .leftJoin(
        receipts,
        and(eq(receipts.operatorId, allocations.operatorId), eq(receipts.paymentId, allocations.paymentId)),
      )
      .leftJoin(
        paymentReversals,
        and(
          eq(paymentReversals.operatorId, allocations.operatorId),
          eq(paymentReversals.paymentId, allocations.paymentId),
        ),
      )
      .leftJoin(
        adjustments,
        and(
          eq(adjustments.operatorId, allocations.operatorId),
          eq(adjustments.id, allocations.creditAdjustmentId),
        ),
      )
      .where(and(eq(allocations.operatorId, operatorId), eq(allocations.invoiceId, invoice.id)))
      .orderBy(asc(allocations.createdAt), asc(allocations.id));
    const bySource = new Map<string, { view: BillPaymentView; applied: number; undone: number }>();
    let paidTotal = 0;
    for (const row of allocationRows) {
      const amount = row.allocation.amountPaise;
      paidTotal += amount;
      const key = row.allocation.sourceId;
      let entry = bySource.get(key);
      if (!entry) {
        entry = {
          applied: 0,
          undone: 0,
          view: {
            sourceType: row.allocation.sourceType,
            sourceId: key,
            amountPaise: toPaise(0),
            undonePaise: toPaise(0),
            appliedAt: row.allocation.createdAt,
            payment:
              row.allocation.sourceType === "payment" && row.payment
                ? {
                    receiptNumber: row.receiptNumber,
                    method: row.payment.method,
                    amountPaise: toPaise(row.payment.amountPaise),
                    recordedAt: dateOf(row.payment.recordedAt),
                    reversed: row.reversalId !== null,
                  }
                : null,
            creditAdjustment: row.credit ? adjustmentView(row.credit) : null,
          },
        };
        bySource.set(key, entry);
      }
      if (amount > 0) entry.applied += amount;
      else entry.undone -= amount;
    }
    const billPayments: BillPaymentView[] = [...bySource.values()].map((entry) => ({
      ...entry.view,
      amountPaise: toPaise(entry.applied),
      undonePaise: toPaise(entry.undone),
    }));

    const [balance] = await tx
      .select({ balance: customerBalances.balancePaise, credit: customerBalances.creditPaise })
      .from(customerBalances)
      .where(
        and(
          eq(customerBalances.operatorId, operatorId),
          eq(customerBalances.customerId, invoice.customerId),
        ),
      );

    const charges = toPaise(invoice.chargesPaise);
    const paidPaise = toPaise(paidTotal);
    const connectionViews: BillConnectionView[] = [...connections.entries()].map(
      ([assignmentId, group]) => ({
        assignmentId,
        vcNumber: group.vcNumber,
        lines: group.lines,
        totalPaise: toPaise(group.lines.reduce((sum, line) => sum + line.amountPaise, 0)),
      }),
    );
    const view: BillDetailView = {
      bill: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        period: toPeriod(invoice.period),
        kind: invoice.kind,
        status: invoice.status,
        issuedAt: invoice.issuedAt,
        openingBalancePaise: toPaise(invoice.openingBalancePaise),
        chargesPaise: charges,
        totalDuePaise: toPaise(invoice.totalDuePaise),
        paidPaise,
        outstandingPaise: toPaise(charges - paidPaise),
        payState: billPayState(invoice.status, charges, paidPaise),
        voidedAt: invoice.voidedAt,
        voidReason: invoice.voidReason,
      },
      customer,
      operator: {
        name: operator.name,
        phone: settings.office_phone ?? operator.phone,
        address: operator.address,
        language: settings.default_language,
        footer: settings.receipt_footer,
      },
      connections: connectionViews,
      otherLines,
      payments: billPayments,
      balance: {
        balancePaise: toPaise(balance?.balance ?? 0),
        creditPaise: toPaise(balance?.credit ?? 0),
      },
    };
    return ok(view);
  },
});
