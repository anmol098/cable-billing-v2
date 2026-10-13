/**
 * `payments.post`: the one path every payment goes through (T-046; PLAN §8.4, §8.7, §10.4;
 * FR-013 to FR-017; PRD §13.2, §13.3; RULE-11 to RULE-13, RULE-16, RULE-17; BR-10, BR-11).
 *
 * One READ COMMITTED transaction (from `defineService`):
 *
 * ```text
 * if payments[operator, id] exists → replay: same payload → duplicate (stored result)
 *                                            different → ID_REUSED_WITH_DIFFERENT_DATA
 * customer must be in the tenant (else NOT_FOUND: rejected, nothing written)
 * lock customer_balances (FOR UPDATE)          # serialises every money change of the customer
 * check the id again                           # a concurrent identical post committed meanwhile
 * open = issued invoices with outstanding > 0  # T-041 invoiceOutstanding
 * allocate(amount, open)                       # T-041: oldest first, remainder = credit
 * review flags (inactive customer / collector, mismatch, clock skew) → posted_needs_review
 * insert payment (ON CONFLICT DO NOTHING: a concurrent post of the same id for another customer
 *   → replay path), ledger(−amount), allocations(kind posting, outstanding_after)
 * receipt number R-YYMM-NNNNN (gap-free counter) + provisional alias
 * customer_balances: balance −= amount, credit += remainder, oldest_due_period
 * collection session (Android payments): totals += amount
 * audit (same transaction)
 * ```
 *
 * Rules:
 * - Identity comes from the TenantContext: the collector is `ctx.userId`, the device
 *   `ctx.deviceId`, the source `android` (mobile) or `web`. `claimedCollectorId` /
 *   `claimedDeviceId` (what the phone says) only raise review flags (T-051 decision 4).
 * - A genuine collection is never rejected for a state change while offline: it is posted and
 *   flagged (PRD §13.3). Only invalid input, an unknown customer and a reused id are refused.
 * - `business_date` = IST date of `recorded_at` (PLAN §8.7); the receipt's YYMM is that date's.
 * - Credit that already existed is not applied here (T-041 rule 5, open question Q-B).
 * - Do not raise the isolation level: after waiting for the balance lock, READ COMMITTED lets the
 *   next statements see what the previous holder committed (REPEATABLE READ would fail with 40001).
 */
import {
  allocations,
  customers,
  ledgerEntries,
  PAYMENT_METHODS,
  type PaymentReviewReason,
  type PaymentSource,
  payments,
  receipts,
  type Tx,
  users,
  uuidv7,
} from "@cb/db";
import {
  addPaise,
  allocate,
  businessDateOf,
  err,
  MAX_INPUT_RUPEES,
  negatePaise,
  ok,
  PAISE_PER_RUPEE,
  paise,
  type Result,
  subtractPaise,
} from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import type { Channel } from "../context/tenant-context";
import { type CoreErrorCode, notFound, type ServiceError, serviceError } from "../errors/errors";
import { nextReceiptNumber, PROVISIONAL_REF_REGEX } from "../receipts/numbering";
import {
  loadCustomerInvoices,
  lockCustomerBalance,
  oldestDuePeriod,
  openInvoicesOf,
  updateCollectionSession,
  writeCustomerBalance,
} from "./ledger-io";
import { type PaymentPayload, payloadDifferences } from "./payload";
import { reviewReasons } from "./review";
import {
  creditAddedOf,
  findStoredPayment,
  loadPostingAllocations,
  type StoredPayment,
  toPaymentView,
} from "./stored";
import type { PaymentAllocationView, PostPaymentResult } from "./types";

/** The largest single payment (13 rupee digits, as the contract's `MAX_AMOUNT_PAISE`). */
export const MAX_PAYMENT_PAISE = MAX_INPUT_RUPEES * PAISE_PER_RUPEE;

const instant = z
  .union([z.date(), z.iso.datetime()])
  .transform((value) => (value instanceof Date ? value : new Date(value)));

/** A UUID in canonical lower case (Postgres returns it so; comparisons stay exact). */
const id = z.uuid().transform((value) => value.toLowerCase());

/**
 * The posting command. Adapters map onto it: T-061 from `PaymentBatchItem` (snake_case → these
 * names; `collector_id` → `claimedCollectorId`, `device_id` → `claimedDeviceId`), T-048 from the
 * counter form (no `recordedAt`, `provisionalRef` or claims).
 */
export const PostPaymentInput = z
  .object({
    /** The client's idempotency key (UUID; the phone's UUIDv7, or one the web form made). */
    id,
    customerId: id,
    amountPaise: z.int().min(1).max(MAX_PAYMENT_PAISE),
    method: z.enum(PAYMENT_METHODS),
    upiReference: z.string().trim().min(1).max(64).nullish(),
    notes: z.string().trim().min(1).max(500).nullish(),
    /** Device clock (UTC). Required on mobile; the web counter defaults to the server time. */
    recordedAt: instant.optional(),
    /** `P-XXX-NNNN`. Required on mobile; none for the web counter. */
    provisionalRef: z.string().regex(PROVISIONAL_REF_REGEX).nullish(),
    /** The user the phone says took the payment (review flag only). */
    claimedCollectorId: id.nullish(),
    /** The device the phone says it was saved on (review flag only; mobile only). */
    claimedDeviceId: id.nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.method !== "upi" && value.upiReference != null) {
      ctx.addIssue({
        code: "custom",
        path: ["upiReference"],
        message: "upiReference is only allowed with method upi",
      });
    }
  });

export type PostPaymentCommand = z.output<typeof PostPaymentInput>;

/** Who is posting: from the TenantContext (or a trusted internal caller). */
export interface PostingActor {
  readonly operatorId: string;
  readonly userId: string;
  readonly channel: Channel;
  /** The signed-in device (mobile). */
  readonly deviceId: string | null;
}

type PostError = ServiceError<CoreErrorCode>;

function requiredFields(paths: string[]): PostError {
  return serviceError("VALIDATION", "Required for mobile payments", {
    fields: paths.map((path) => ({ path, code: "required" })),
  });
}

function payloadOf(command: PostPaymentCommand): PaymentPayload {
  return {
    customerId: command.customerId,
    amountPaise: command.amountPaise,
    method: command.method,
    upiReference: command.upiReference ?? null,
    notes: command.notes ?? null,
    provisionalRef: command.provisionalRef ?? null,
    recordedAt: command.recordedAt ?? null,
  };
}

/** The replay of an id already stored: the stored result, or ID_REUSED_WITH_DIFFERENT_DATA. */
async function replay(
  tx: Tx,
  operatorId: string,
  stored: StoredPayment,
  command: PostPaymentCommand,
): Promise<Result<PostPaymentResult, PostError>> {
  const { row, receipt } = stored;
  const differences = payloadDifferences(payloadOf(command), {
    customerId: row.customerId,
    amountPaise: row.amountPaise,
    method: row.method,
    upiReference: row.upiReference,
    notes: row.notes,
    provisionalRef: receipt?.provisionalRef ?? null,
    recordedAt: row.recordedAt,
  });
  // A migrated payment (no receipt or snapshots from this service) can't be replayed by a client.
  if (
    receipt === null ||
    row.balanceAfterPaise === null ||
    row.creditAfterPaise === null ||
    row.source === "migration"
  ) {
    differences.push("source");
  }
  if (differences.length > 0 || receipt === null) {
    return err(
      serviceError("ID_REUSED_WITH_DIFFERENT_DATA", "Payment id already used for other data", {
        fields: differences,
      }),
    );
  }
  const payment = toPaymentView(row);
  const postingAllocations = await loadPostingAllocations(tx, operatorId, row.id);
  return ok({
    outcome: "duplicate",
    payment,
    allocations: postingAllocations,
    receipt,
    newBalance: paise(row.balanceAfterPaise ?? 0),
    credit: paise(row.creditAfterPaise ?? 0),
    creditAddedPaise: creditAddedOf(payment.amountPaise, postingAllocations),
    reviewReasons: row.reviewReason ? [row.reviewReason] : [],
    reversed: stored.reversed,
  });
}

/** The status of the user the phone names, if any: `unknown` when not in this tenant. */
async function claimedCollectorStatus(
  tx: Tx,
  operatorId: string,
  claimedId: string,
): Promise<"active" | "disabled" | "unknown"> {
  const [row] = await tx
    .select({ status: users.status })
    .from(users)
    .where(and(eq(users.operatorId, operatorId), eq(users.id, claimedId)));
  return row?.status ?? "unknown";
}

/**
 * The posting algorithm (PLAN §8.4) inside the caller's tenant transaction. `postPayment` is the
 * public entry point (authorization, validation, audit); this is exported for core's own tests
 * and isolation seeds only.
 */
export async function postPaymentInTx(
  tx: Tx,
  actor: PostingActor,
  command: PostPaymentCommand,
  now: Date,
): Promise<Result<PostPaymentResult, PostError>> {
  const { operatorId } = actor;
  const source: PaymentSource = actor.channel === "mobile" ? "android" : "web";
  if (source === "android") {
    if (actor.deviceId === null) throw new Error("mobile posting without a signed-in device");
    const missing = [
      ...(command.recordedAt === undefined ? ["recordedAt"] : []),
      ...(command.provisionalRef == null ? ["provisionalRef"] : []),
    ];
    if (missing.length > 0) return err(requiredFields(missing));
  } else if (command.claimedDeviceId != null) {
    return err(
      serviceError("VALIDATION", "claimedDeviceId is for mobile payments only", {
        fields: [{ path: "claimedDeviceId", code: "not_allowed" }],
      }),
    );
  }

  // 1. Idempotency: a replay never touches anything.
  const existing = await findStoredPayment(tx, operatorId, command.id);
  if (existing) return replay(tx, operatorId, existing, command);

  // 2. The customer must be this tenant's (RLS: another tenant's id is not found).
  const [customer] = await tx
    .select({ id: customers.id, status: customers.status })
    .from(customers)
    .where(and(eq(customers.operatorId, operatorId), eq(customers.id, command.customerId)));
  if (!customer) return err(notFound());

  // 3. Serialise on the customer, then look at the id again.
  const before = await lockCustomerBalance(tx, operatorId, customer.id);
  const raced = await findStoredPayment(tx, operatorId, command.id);
  if (raced) return replay(tx, operatorId, raced, command);

  // 4. Allocation (T-041), oldest bill first; the remainder is credit.
  const amountPaise = paise(command.amountPaise);
  const customerInvoices = await loadCustomerInvoices(tx, operatorId, customer.id);
  const allocated = allocate(amountPaise, openInvoicesOf(customerInvoices));
  if (!allocated.ok) return err(allocated.error);
  const invoiceById = new Map(customerInvoices.map((inv) => [inv.id, inv]));

  // 5. Review flags (never a rejection).
  const recordedAt = command.recordedAt ?? now;
  const claimed = command.claimedCollectorId ?? null;
  const reasons: PaymentReviewReason[] = reviewReasons({
    now,
    recordedAt,
    customerActive: customer.status === "active",
    collectorId: actor.userId,
    deviceId: actor.deviceId,
    ...(claimed === null
      ? {}
      : {
          claimedCollector: {
            id: claimed,
            status:
              claimed === actor.userId
                ? "active"
                : await claimedCollectorStatus(tx, operatorId, claimed),
          },
        }),
    claimedDeviceId: command.claimedDeviceId ?? null,
  });
  const reviewReason = reasons[0] ?? null;
  const businessDate = businessDateOf(recordedAt);
  const balanceAfter = subtractPaise(before.balancePaise, amountPaise);
  const creditAfter = addPaise(before.creditPaise, allocated.value.creditPaise);

  // 6. The payment. A concurrent post of the same id for another customer → replay path.
  const [inserted] = await tx
    .insert(payments)
    .values({
      id: command.id,
      operatorId,
      customerId: customer.id,
      amountPaise,
      method: command.method,
      upiReference: command.upiReference ?? null,
      notes: command.notes ?? null,
      collectorId: actor.userId,
      deviceId: source === "android" ? actor.deviceId : null,
      source,
      recordedAt,
      postedAt: now,
      businessDate,
      balanceAfterPaise: balanceAfter,
      creditAfterPaise: creditAfter,
      reviewStatus: reviewReason === null ? "none" : "needs_review",
      reviewReason,
    })
    .onConflictDoNothing({ target: [payments.operatorId, payments.id] })
    .returning();
  if (!inserted) {
    const winner = await findStoredPayment(tx, operatorId, command.id);
    if (!winner) throw new Error("payment insert conflicted but no payment is visible");
    return replay(tx, operatorId, winner, command);
  }

  // 7. Ledger (− amount) and allocation rows with the invoice's outstanding after each.
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId,
    customerId: customer.id,
    type: "payment",
    amountPaise: negatePaise(amountPaise),
    paymentId: inserted.id,
    at: now,
  });
  const postingAllocations: PaymentAllocationView[] = [];
  for (const row of allocated.value.allocations) {
    const invoice = invoiceById.get(row.invoiceId);
    if (!invoice) throw new Error("allocated to an invoice that was not loaded");
    const outstandingAfter = subtractPaise(invoice.outstandingPaise, row.amountPaise);
    const id = uuidv7();
    await tx.insert(allocations).values({
      id,
      operatorId,
      customerId: customer.id,
      invoiceId: row.invoiceId,
      sourceType: "payment",
      paymentId: inserted.id,
      kind: "posting",
      amountPaise: row.amountPaise,
      outstandingAfterPaise: outstandingAfter,
      createdAt: now,
    });
    postingAllocations.push({
      id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceKind: invoice.kind,
      period: invoice.period,
      amountPaise: row.amountPaise,
      outstandingAfterPaise: outstandingAfter,
    });
  }

  // 8. Receipt: permanent number (gap-free counter, taken late: it locks the tenant's counter)
  //    with the phone's provisional reference kept as its alias.
  const receiptNumber = await nextReceiptNumber(tx, operatorId, businessDate);
  const receiptId = uuidv7();
  const provisionalRef = command.provisionalRef ?? null;
  await tx.insert(receipts).values({
    id: receiptId,
    operatorId,
    paymentId: inserted.id,
    receiptNumber,
    provisionalRef,
    issuedAt: now,
  });

  // 9. Read model and collection session.
  await writeCustomerBalance(tx, operatorId, customer.id, {
    balancePaise: balanceAfter,
    creditPaise: creditAfter,
    oldestDuePeriod: oldestDuePeriod(allocated.value.openInvoices),
    now,
  });
  if (source === "android") {
    await updateCollectionSession(tx, {
      operatorId,
      collectorId: actor.userId,
      businessDate,
      method: command.method,
      amountPaise,
      sign: 1,
      now,
    });
  }

  return ok({
    outcome: reviewReason === null ? "posted" : "posted_needs_review",
    payment: toPaymentView(inserted),
    allocations: postingAllocations,
    receipt: { id: receiptId, receiptNumber, provisionalRef, issuedAt: now },
    newBalance: balanceAfter,
    credit: creditAfter,
    creditAddedPaise: allocated.value.creditPaise,
    reviewReasons: reasons,
    reversed: false,
  });
}

/**
 * Posts a payment (counter or field). Capability `payments.record` (Owner, Staff, Lineman;
 * allowed in read-only mode, D-13). Errors: VALIDATION (input; mobile without `recordedAt` /
 * `provisionalRef`), NOT_FOUND (customer not in the tenant), ID_REUSED_WITH_DIFFERENT_DATA,
 * CONFLICT with `details.retryable` (a rare lock/serialisation failure: retry), INTERNAL.
 */
export const postPayment = defineService({
  name: "payments.post",
  capability: "payments.record",
  input: PostPaymentInput,
  async run({ ctx, input, tx, audit, log, now }) {
    const result = await postPaymentInTx(
      tx,
      {
        operatorId: ctx.operatorId,
        userId: ctx.userId,
        channel: ctx.channel,
        deviceId: ctx.deviceId ?? null,
      },
      input,
      now,
    );
    if (!result.ok) return result;
    const posted = result.value;
    if (posted.outcome === "duplicate") {
      audit.skip("idempotent_replay");
    } else {
      await audit.record({
        entityType: "payment",
        entityId: posted.payment.id,
        after: {
          customer_id: posted.payment.customerId,
          amount_paise: posted.payment.amountPaise,
          method: posted.payment.method,
          source: posted.payment.source,
          business_date: posted.payment.businessDate,
          receipt_number: posted.receipt.receiptNumber,
          allocations: posted.allocations.map((a) => ({
            invoice_id: a.invoiceId,
            amount_paise: a.amountPaise,
          })),
          credit_added_paise: posted.creditAddedPaise,
          balance_after_paise: posted.newBalance,
          credit_after_paise: posted.credit,
          review_reasons: posted.reviewReasons,
        },
      });
    }
    log.info("payment.posted", {
      payment_id: posted.payment.id,
      customer_id: posted.payment.customerId,
      outcome: posted.outcome,
      amount_paise: posted.payment.amountPaise,
      allocation_count: posted.allocations.length,
      ...(posted.payment.reviewReason ? { review_reason: posted.payment.reviewReason } : {}),
    });
    return ok(posted);
  },
});
