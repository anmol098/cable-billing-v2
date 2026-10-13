/**
 * `receipts.record_action`: stores one thing the lineman observably did with a receipt (T-061;
 * PLAN §10.2 `POST /receipts/actions:batch`, §11.7; FR-017 to FR-020; BR-12, RULE-19).
 *
 * - Honest states only: `printed`, `print_failed`, `whatsapp_opened`, `sms_opened`, `pdf_shared`
 *   (the `receipt_action` enum has no "sent" or "delivered" value).
 * - Idempotent on the phone's action id, per tenant (`receipt_actions` primary key
 *   `(operator_id, id)`): the same id with the same payment, action and time → `duplicate` (nothing
 *   written); with other data → ID_REUSED_WITH_DIFFERENT_DATA (`details.fields` = names only).
 * - The payment must be in the tenant and posted (it has a receipt): NOT_FOUND otherwise, also for
 *   another tenant's payment id.
 * - Who and where come from the TenantContext (`actor_id` = `ctx.userId`, `device_id` =
 *   `ctx.deviceId`); `at` is the phone's clock, `received_at` the server's.
 * - Capability `receipts.share` (Owner, Staff, Lineman; allowed in read-only mode, D-13). Not
 *   audited (the capability isn't): the append-only row is itself the record.
 */
import { RECEIPT_ACTIONS, type ReceiptAction, receiptActions, receipts, type Tx } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../../context/service";
import { notFound, type ServiceError, serviceError } from "../../errors/errors";

/** A UUID in canonical lower case (Postgres returns it so; comparisons stay exact). */
const id = z.uuid().transform((value) => value.toLowerCase());

export const RecordReceiptActionInput = z.object({
  /** The phone's idempotency key for this action (contract `ReceiptActionItem.id`). */
  id,
  /** The payment whose receipt it was. */
  paymentId: id,
  action: z.enum(RECEIPT_ACTIONS),
  /** When it happened, by the phone's clock (UTC). */
  at: z
    .union([z.date(), z.iso.datetime()])
    .transform((value) => (value instanceof Date ? value : new Date(value))),
});

export type RecordReceiptActionCommand = z.output<typeof RecordReceiptActionInput>;

export interface RecordedReceiptAction {
  /** `recorded`: stored now. `duplicate`: this id was already stored with the same data. */
  readonly outcome: "recorded" | "duplicate";
  readonly id: string;
  readonly receiptId: string;
  readonly action: ReceiptAction;
  readonly at: Date;
}

type RecordError = ServiceError<"NOT_FOUND" | "ID_REUSED_WITH_DIFFERENT_DATA">;

interface StoredAction {
  readonly receiptId: string;
  readonly action: ReceiptAction;
  readonly at: Date;
}

async function findAction(tx: Tx, operatorId: string, actionId: string) {
  const [row] = await tx
    .select({
      receiptId: receiptActions.receiptId,
      action: receiptActions.action,
      at: receiptActions.at,
    })
    .from(receiptActions)
    .where(and(eq(receiptActions.operatorId, operatorId), eq(receiptActions.id, actionId)))
    .limit(1);
  return row;
}

/** The replay of an id already stored: `duplicate`, or ID_REUSED_WITH_DIFFERENT_DATA. */
function replay(
  stored: StoredAction,
  command: RecordReceiptActionCommand,
  receiptId: string,
): Result<RecordedReceiptAction, RecordError> {
  const differences: string[] = [];
  if (stored.receiptId !== receiptId) differences.push("paymentId");
  if (stored.action !== command.action) differences.push("action");
  if (stored.at.getTime() !== command.at.getTime()) differences.push("at");
  if (differences.length > 0) {
    return err(
      serviceError("ID_REUSED_WITH_DIFFERENT_DATA", "Action id already used for other data", {
        fields: differences,
      }),
    );
  }
  return ok({
    outcome: "duplicate",
    id: command.id,
    receiptId,
    action: stored.action,
    at: stored.at,
  });
}

export const recordReceiptAction = defineService<
  typeof RecordReceiptActionInput,
  RecordedReceiptAction,
  "NOT_FOUND" | "ID_REUSED_WITH_DIFFERENT_DATA"
>({
  name: "receipts.record_action",
  capability: "receipts.share",
  input: RecordReceiptActionInput,
  async run({ ctx, input, tx, log, now }) {
    const [receipt] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.operatorId, ctx.operatorId), eq(receipts.paymentId, input.paymentId)))
      .limit(1);
    if (!receipt) return err(notFound());

    const existing = await findAction(tx, ctx.operatorId, input.id);
    if (existing) return replay(existing, input, receipt.id);

    const inserted = await tx
      .insert(receiptActions)
      .values({
        id: input.id,
        operatorId: ctx.operatorId,
        receiptId: receipt.id,
        action: input.action,
        deviceId: ctx.deviceId ?? null,
        actorId: ctx.userId,
        at: input.at,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: receiptActions.id });
    if (inserted.length === 0) {
      // A concurrent request with the same id committed first (we waited on its key): replay it.
      const raced = await findAction(tx, ctx.operatorId, input.id);
      if (!raced) throw new Error("receipt action vanished after a key conflict");
      return replay(raced, input, receipt.id);
    }
    log.info("receipt_action.recorded", { receipt_id: receipt.id, action: input.action });
    return ok({
      outcome: "recorded",
      id: input.id,
      receiptId: receipt.id,
      action: input.action,
      at: input.at,
    });
  },
});
