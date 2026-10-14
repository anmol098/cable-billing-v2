/**
 * Input schemas of the connection services (T-034). Field problems come back as VALIDATION with
 * `details.fields[{ path, code }]` (T-025): e.g. `vcNumber`/`invalid_vc`, `planId`/`plan_or_amount`,
 * `startDate`/`invalid_date`.
 */
import { normalizeVcNumber } from "@cb/db";
import { type BusinessDate, isBusinessDate } from "@cb/domain";
import { z } from "zod";
import { CreateCustomerInput } from "../customers/customers";
import { CONNECTION_LIMITS, STOP_REASONS, VC_NUMBER_PATTERN } from "./rules";

const id = () => z.uuid().transform((value) => value.toLowerCase());

/** `YYYY-MM-DD`, a real calendar date (IST business date). */
export const businessDateField = () =>
  z
    .string()
    .refine((value) => isBusinessDate(value), { message: "invalid_date" })
    .transform((value) => value as BusinessDate);

/**
 * A VC number as typed: outer spaces trimmed, inner runs of spaces made one. Its normalised form
 * (T-022: spaces and `-` removed, ASCII upper-case) must be 1–64 printable ASCII characters.
 */
export const vcNumberField = () =>
  z
    .string()
    .max(CONNECTION_LIMITS.vcNumberInput)
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .refine(
      (value) => {
        const norm = normalizeVcNumber(value);
        return (
          norm.length > 0 &&
          norm.length <= CONNECTION_LIMITS.vcNumber &&
          VC_NUMBER_PATTERN.test(norm)
        );
      },
      { message: "invalid_vc" },
    );

/** A monthly rent in paise (an "own amount"): 0 … ₹1,00,000. */
export const rentalPaiseField = () => z.number().int().min(0).max(CONNECTION_LIMITS.maxRentalPaise);

/** Plan or own amount: exactly one of the two. */
const planOrAmount = {
  /** An active plan of this business: its monthly amount is copied (FR-007). */
  planId: id().nullish(),
  /** An own amount in paise, when there is no plan. */
  rentalPaise: rentalPaiseField().nullish(),
};

function requireOnePlanOrAmount(
  value: { planId?: string | null; rentalPaise?: number | null },
  ctx: z.RefinementCtx,
) {
  const hasPlan = value.planId !== undefined && value.planId !== null;
  const hasAmount = value.rentalPaise !== undefined && value.rentalPaise !== null;
  if (hasPlan === hasAmount) {
    ctx.addIssue({ code: "custom", path: ["planId"], message: "plan_or_amount" });
  }
}

/** One new connection (without the customer): the add-customer step and the Connections tab. */
export const ConnectionFields = z
  .object({
    vcNumber: vcNumberField(),
    ...planOrAmount,
    /** First day of service. */
    startDate: businessDateField(),
  })
  .superRefine(requireOnePlanOrAmount);
export type ConnectionFieldsCommand = z.output<typeof ConnectionFields>;

export const AddConnectionInput = z
  .object({
    customerId: id(),
    vcNumber: vcNumberField(),
    ...planOrAmount,
    startDate: businessDateField(),
  })
  .superRefine(requireOnePlanOrAmount);
export type AddConnectionCommand = z.output<typeof AddConnectionInput>;

const note = () => z.string().trim().max(CONNECTION_LIMITS.note).nullish();

export const SuspendConnectionInput = z.object({
  assignmentId: id(),
  effectiveDate: businessDateField(),
  /** Optional for a stop. */
  reason: z.enum(STOP_REASONS).nullish(),
  note: note(),
});

export const ReactivateConnectionInput = z.object({
  assignmentId: id(),
  effectiveDate: businessDateField(),
});

export const DisconnectConnectionInput = z.object({
  assignmentId: id(),
  effectiveDate: businessDateField(),
  /** Required for a removal (FR-006 "reason/audit metadata"). */
  reason: z.enum(STOP_REASONS),
  note: note(),
});

export const ChangeConnectionPlanInput = z
  .object({
    assignmentId: id(),
    effectiveDate: businessDateField(),
    ...planOrAmount,
  })
  .superRefine(requireOnePlanOrAmount);

export const CreateCustomerWithConnectionsInput = z.object({
  customer: CreateCustomerInput,
  connections: z.array(ConnectionFields).max(CONNECTION_LIMITS.connectionsPerCustomer).default([]),
});

export const ListConnectionsInput = z.object({ customerId: id() });

export const ConnectionFormOptionsInput = z.object({ customerId: id().optional() });
