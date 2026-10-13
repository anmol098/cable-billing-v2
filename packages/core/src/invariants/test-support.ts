/**
 * Test support for the invariants tests (not exported from the package; no side effects, so the
 * isolation discovery can import it). Builds a tenant's healthy books through the real services
 * and T-044/T-046 test seeders, and injects corruption through the raw admin pool.
 */
import { type DbClient, type Tx, uuidv7 } from "@cb/db";
import type { TestDatabase } from "@cb/db/testing";
import { addAdjustment, addConnection } from "../billing/test-support";
import { postPayment } from "../payments/post-payment";
import { reversePayment } from "../payments/reverse-payment";
import { insertCustomer, issueInvoice } from "../payments/test-support";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";

/** Ids of a tenant's healthy books (see {@link seedHealthyBooks}). */
export interface HealthyBooks {
  readonly tenant: SeededTenant;
  readonly operatorId: string;
  /** Oct bill ₹500, paid ₹200: owes ₹300. `invoices[0]` is open. */
  readonly partly: { customerId: string; invoiceId: string; paymentId: string };
  /** Oct bill ₹300, paid ₹500 (₹200 credit), Nov bill ₹300 took the ₹200: owes ₹100. */
  readonly advance: {
    customerId: string;
    octInvoiceId: string;
    novInvoiceId: string;
    paymentId: string;
  };
  /** Oct bill ₹400, paid in full, payment reversed: owes ₹400. */
  readonly reversed: { customerId: string; invoiceId: string; paymentId: string };
  /** ₹100 credit adjustment, then Oct bill ₹250 (credit adjustments wait for a run): owes ₹150. */
  readonly credited: { customerId: string; adjustmentId: string; invoiceId: string };
  /** Two connections, one VC reused after a disconnection (no overlap). No money. */
  readonly connected: { customerId: string; assetId: string; assignmentIds: string[] };
}

const OCT = "2026-10-01";
const NOV = "2026-11-01";

/** A tenant with a little of everything the checks look at, all consistent. */
export async function seedHealthyBooks(
  database: Pick<TestDatabase, "admin" | "db">,
  now: Date,
): Promise<HealthyBooks> {
  const db: DbClient = database.db;
  const tenant = await seedTenant(database);
  const operatorId = tenant.operatorId;
  const rt = testRuntime(db, { now: () => now });
  const owner = await contextFor(rt, tenant, "owner");
  const pay = async (customerId: string, amountPaise: number) => {
    const id = uuidv7();
    const r = await postPayment.call(rt, owner, { id, customerId, amountPaise, method: "cash" });
    if (!r.ok) throw new Error(`postPayment: ${r.error.code}`);
    return id;
  };
  const tenantTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => db.withTenant(operatorId, fn);

  const partlyId = await tenantTx((tx) => insertCustomer(tx, operatorId));
  const partlyInvoice = await tenantTx((tx) =>
    issueInvoice(tx, operatorId, partlyId, { period: OCT, chargesPaise: 50_000 }),
  );
  const partlyPayment = await pay(partlyId, 20_000);

  const advanceId = await tenantTx((tx) => insertCustomer(tx, operatorId));
  const advanceOct = await tenantTx((tx) =>
    issueInvoice(tx, operatorId, advanceId, { period: OCT, chargesPaise: 30_000 }),
  );
  const advancePayment = await pay(advanceId, 50_000);
  const advanceNov = await tenantTx((tx) =>
    issueInvoice(tx, operatorId, advanceId, { period: NOV, chargesPaise: 30_000 }),
  );

  const reversedId = await tenantTx((tx) => insertCustomer(tx, operatorId));
  const reversedInvoice = await tenantTx((tx) =>
    issueInvoice(tx, operatorId, reversedId, { period: OCT, chargesPaise: 40_000 }),
  );
  const reversedPayment = await pay(reversedId, 40_000);
  const reversal = await reversePayment.call(rt, owner, {
    paymentId: reversedPayment,
    reason: "Test reversal",
  });
  if (!reversal.ok) throw new Error(`reversePayment: ${reversal.error.code}`);

  const creditedId = await tenantTx((tx) => insertCustomer(tx, operatorId));
  const adjustmentId = await tenantTx((tx) =>
    addAdjustment(tx, operatorId, {
      customerId: creditedId,
      direction: "credit",
      amountPaise: 10_000,
      source: "manual",
      createdBy: tenant.users.owner,
    }),
  );
  const creditedInvoice = await tenantTx((tx) =>
    issueInvoice(tx, operatorId, creditedId, { period: OCT, chargesPaise: 25_000 }),
  );

  const connectedId = await tenantTx((tx) => insertCustomer(tx, operatorId));
  const firstAssignment = await tenantTx((tx) =>
    addConnection(tx, operatorId, connectedId, {
      startDate: "2026-01-10",
      rentalPaise: 30_000,
      events: [{ type: "disconnected", date: "2026-05-31" }],
    }),
  );
  const { rows } = await database.admin.query<{ vc_asset_id: string }>(
    "SELECT vc_asset_id FROM vc_assignments WHERE id = $1",
    [firstAssignment],
  );
  const assetId = String(rows[0]?.vc_asset_id);
  // The same VC again from the next day (RULE-07 reuse): touching ranges, no overlap.
  const reuse = await insertAssignment(database, {
    operatorId,
    customerId: connectedId,
    assetId,
    startDate: "2026-06-01",
  });
  const second = await tenantTx((tx) =>
    addConnection(tx, operatorId, connectedId, { startDate: "2026-03-01", rentalPaise: 20_000 }),
  );

  return {
    tenant,
    operatorId,
    partly: { customerId: partlyId, invoiceId: partlyInvoice, paymentId: partlyPayment },
    advance: {
      customerId: advanceId,
      octInvoiceId: advanceOct,
      novInvoiceId: advanceNov,
      paymentId: advancePayment,
    },
    reversed: { customerId: reversedId, invoiceId: reversedInvoice, paymentId: reversedPayment },
    credited: { customerId: creditedId, adjustmentId, invoiceId: creditedInvoice },
    connected: {
      customerId: connectedId,
      assetId,
      assignmentIds: [firstAssignment, reuse, second],
    },
  };
}

/** Inserts a VC assignment row directly (admin pool). Returns its id. */
export async function insertAssignment(
  database: Pick<TestDatabase, "admin">,
  input: {
    operatorId: string;
    customerId: string;
    assetId: string;
    startDate: string;
    endDate?: string | null;
  },
): Promise<string> {
  const id = uuidv7();
  await database.admin.query(
    `INSERT INTO vc_assignments (id, operator_id, vc_asset_id, customer_id, start_date, end_date,
                                 status, rental_amount_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 30000)`,
    [
      id,
      input.operatorId,
      input.assetId,
      input.customerId,
      input.startDate,
      input.endDate ?? null,
      input.endDate ? "disconnected" : "active",
    ],
  );
  return id;
}

/**
 * Runs `statements` on one admin connection with `session_replication_role = replica`, which
 * switches off **triggers** (the append-only and allocation-reversal triggers, and foreign-key
 * checks) for that connection only, inside one transaction. CHECK, UNIQUE and EXCLUDE constraints
 * still apply. Tests only: it is how corruption that the database would refuse is injected.
 */
export async function withTriggersOff(
  database: Pick<TestDatabase, "admin">,
  statements: ReadonlyArray<readonly [string, readonly unknown[]]>,
): Promise<void> {
  const client = await database.admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const [text, params] of statements) await client.query(text, [...params]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Inserts a positive allocation row directly (admin pool), as a buggy writer would. */
export async function insertAllocation(
  database: Pick<TestDatabase, "admin">,
  input: {
    operatorId: string;
    customerId: string;
    invoiceId: string;
    amountPaise: number;
    paymentId?: string;
    creditAdjustmentId?: string;
    kind?: "posting" | "credit_application";
  },
): Promise<string> {
  const id = uuidv7();
  const sourceType = input.paymentId ? "payment" : "credit_adjustment";
  await database.admin.query(
    `INSERT INTO allocations (id, operator_id, customer_id, invoice_id, source_type, payment_id,
                              credit_adjustment_id, kind, amount_paise, outstanding_after_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`,
    [
      id,
      input.operatorId,
      input.customerId,
      input.invoiceId,
      sourceType,
      input.paymentId ?? null,
      input.creditAdjustmentId ?? null,
      input.kind ?? (input.paymentId ? "posting" : "credit_application"),
      input.amountPaise,
    ],
  );
  return id;
}
