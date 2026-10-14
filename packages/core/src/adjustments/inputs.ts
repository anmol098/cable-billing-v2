/**
 * Input schemas of the adjustment services (T-045). Field problems come back as VALIDATION with
 * `details.fields[{ path, code }]` (T-025).
 */
import { ADJUSTMENT_DIRECTIONS, ADJUSTMENT_SOURCES } from "@cb/domain";
import { z } from "zod";
import { businessDateField, rentalPaiseField } from "../connections/inputs";
import { CONNECTION_LIMITS, STOP_REASONS } from "../connections/rules";

const id = () => z.uuid().transform((value) => value.toLowerCase());

export const ADJUSTMENT_LIMITS = {
  /** Characters of a reason (the Owner says why, in a few words). */
  reasonMin: 3,
  reasonMax: 200,
  /** Largest manual adjustment: ₹1,00,000 (a typing slip above that). */
  maxAmountPaise: 10_000_000,
  /** Rows per page of the adjustments list. */
  pageSize: 50,
  /** Months back the Connections tab's "Start again" effect knows about. */
  chargedMonthsBack: 6,
} as const;

/** Why (required for every Owner adjustment and back-dated change). */
export const reasonField = () =>
  z.string().trim().min(ADJUSTMENT_LIMITS.reasonMin).max(ADJUSTMENT_LIMITS.reasonMax);

/** An Owner's manual bill change (debit = more to pay, credit = less to pay). */
export const CreateManualAdjustmentInput = z.object({
  /** Made by the form when it opens: sending the same form twice saves it once. */
  id: id(),
  customerId: id(),
  direction: z.enum(ADJUSTMENT_DIRECTIONS),
  amountPaise: z.number().int().min(1).max(ADJUSTMENT_LIMITS.maxAmountPaise),
  reason: reasonField(),
  /** Optional: the connection it is about (must be the customer's). */
  assignmentId: id().nullish(),
});
export type CreateManualAdjustmentCommand = z.output<typeof CreateManualAdjustmentInput>;

/** A change to an existing connection (what the preview and the back-dated flow take). */
export const ConnectionChange = z
  .object({
    kind: z.enum(["plan", "suspend", "reactivate", "disconnect"]),
    /** plan: an active plan of this business … */
    planId: id().nullish(),
    /** … or an own amount in paise. */
    rentalPaise: rentalPaiseField().nullish(),
    /** suspend (optional) / disconnect (required). */
    stopReason: z.enum(STOP_REASONS).nullish(),
    note: z.string().trim().max(CONNECTION_LIMITS.note).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "plan") {
      const hasPlan = value.planId !== undefined && value.planId !== null;
      const hasAmount = value.rentalPaise !== undefined && value.rentalPaise !== null;
      if (hasPlan === hasAmount) {
        ctx.addIssue({ code: "custom", path: ["planId"], message: "plan_or_amount" });
      }
    }
    if (value.kind === "disconnect" && !value.stopReason) {
      ctx.addIssue({ code: "custom", path: ["stopReason"], message: "required" });
    }
  });
export type ConnectionChangeCommand = z.output<typeof ConnectionChange>;

export const PreviewConnectionChangeInput = z.object({
  assignmentId: id(),
  effectiveDate: businessDateField(),
  change: ConnectionChange,
});

export const BackDatedChangeInput = z.object({
  assignmentId: id(),
  effectiveDate: businessDateField(),
  change: ConnectionChange,
  /** The Owner's reason, stored on every adjustment the change makes. */
  reason: reasonField(),
});

export const ADJUSTMENT_STATES = ["pending", "billed", "credit"] as const;

export const ListAdjustmentsInput = z.object({
  page: z.number().int().min(1).max(10_000).default(1),
  source: z.enum(ADJUSTMENT_SOURCES).nullish(),
  state: z.enum(ADJUSTMENT_STATES).nullish(),
  customerId: id().nullish(),
});

export const ConnectionChargedMonthsInput = z.object({ customerId: id() });
