/**
 * Reads seeded accounts back from the database and checks them with T-041's `checkLedger`
 * (PLAN §8.4 invariants), the same mapping as `schema/ledger.test.ts`'s `ledgerState` and the
 * nightly job's (T-052). Used by the seed CLI after inserting and by the seed tests.
 */
import { checkLedger, type LedgerState, type LedgerViolationCode, toPaise } from "@cb/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbClient } from "../client";
import {
  adjustments,
  allocations,
  customerBalances,
  customers,
  invoices,
  ledgerEntries,
  operators,
  paymentReversals,
  payments,
} from "../schema";
import type { Tx } from "../tenant";

/** One customer's rows as T-041's `LedgerState` (inside that customer's `withTenant`). */
export async function readLedgerState(
  tx: Tx,
  operatorId: string,
  customerId: string,
): Promise<LedgerState> {
  const own = (table: { operatorId: AnyPgColumn; customerId: AnyPgColumn }) =>
    and(eq(table.operatorId, operatorId), eq(table.customerId, customerId));
  const invoiceRows = await tx
    .select({ id: invoices.id, chargesPaise: invoices.chargesPaise })
    .from(invoices)
    .where(own(invoices));
  const paymentRows = await tx
    .select({ id: payments.id, amountPaise: payments.amountPaise, reversalId: paymentReversals.id })
    .from(payments)
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(own(payments));
  const creditRows = await tx
    .select({ id: adjustments.id, amountPaise: adjustments.amountPaise })
    .from(adjustments)
    .where(and(own(adjustments), eq(adjustments.direction, "credit")));
  const allocationRows = await tx
    .select()
    .from(allocations)
    .where(own(allocations))
    .orderBy(asc(allocations.createdAt), asc(allocations.id));
  const entryRows = await tx
    .select({ type: ledgerEntries.type, amountPaise: ledgerEntries.amountPaise })
    .from(ledgerEntries)
    .where(own(ledgerEntries))
    .orderBy(asc(ledgerEntries.seq));
  const [balance] = await tx
    .select({
      balancePaise: customerBalances.balancePaise,
      creditPaise: customerBalances.creditPaise,
    })
    .from(customerBalances)
    .where(own(customerBalances));
  return {
    invoices: invoiceRows.map((i) => ({ id: i.id, chargesPaise: toPaise(i.chargesPaise) })),
    payments: paymentRows.map((p) => ({
      id: p.id,
      amountPaise: toPaise(p.amountPaise),
      reversed: p.reversalId !== null,
    })),
    creditAdjustments: creditRows.map((c) => ({ id: c.id, amountPaise: toPaise(c.amountPaise) })),
    allocations: allocationRows.map((r) => ({
      id: r.id,
      invoiceId: r.invoiceId,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      amountPaise: toPaise(r.amountPaise),
      reversalId: r.reversalId,
    })),
    ledgerEntries: entryRows.map((e) => ({ type: e.type, amountPaise: toPaise(e.amountPaise) })),
    balancePaise: toPaise(balance?.balancePaise ?? 0),
    creditPaise: toPaise(balance?.creditPaise ?? 0),
  };
}

export interface LedgerSampleReport {
  /** Customers checked. */
  readonly checked: number;
  /** Customers with at least one violation (ids and codes only). */
  readonly failures: readonly {
    readonly operatorId: string;
    readonly customerId: string;
    readonly codes: readonly LedgerViolationCode[];
  }[];
}

/**
 * Runs `checkLedger` on up to `perOperator` customers of every operator (a fixed pseudo-random
 * sample: ordered by `md5(id)`, so reruns check the same customers). `perOperator: Infinity`
 * checks everyone.
 */
export async function verifyLedgerSample(
  db: DbClient,
  options: { perOperator: number },
): Promise<LedgerSampleReport> {
  const tenants = await db.withPlatform((tx) =>
    tx.select({ id: operators.id }).from(operators).orderBy(asc(operators.id)),
  );
  let checked = 0;
  const failures: { operatorId: string; customerId: string; codes: LedgerViolationCode[] }[] = [];
  for (const { id: operatorId } of tenants) {
    await db.withTenant(
      operatorId,
      async (tx) => {
        const query = tx
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.operatorId, operatorId))
          .orderBy(sql`md5(${customers.id}::text)`);
        const sample = Number.isFinite(options.perOperator)
          ? await query.limit(Math.max(0, Math.floor(options.perOperator)))
          : await query;
        for (const { id: customerId } of sample) {
          const violations = checkLedger(await readLedgerState(tx, operatorId, customerId));
          checked += 1;
          if (violations.length > 0) {
            failures.push({ operatorId, customerId, codes: violations.map((v) => v.code) });
          }
        }
      },
      { accessMode: "read only" },
    );
  }
  return { checked, failures };
}
