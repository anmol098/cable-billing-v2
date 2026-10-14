/**
 * Inputs and results of the customer import services (T-084).
 */
import type { BusinessDate } from "@cb/domain";
import { z } from "zod";
import { IMPORT_FIELDS, type ImportField } from "./columns";
import { IMPORT_LIMITS } from "./limits";
import type { LineProblem } from "./rules";

const cell = () => z.string().max(IMPORT_LIMITS.cellChars).default("");

/** One line as the file reader produced it (`ImportLine`): its row number and field texts. */
export const ImportLineInput = z.object({
  line: z.number().int().min(1).max(1_048_576),
  values: z.object(
    Object.fromEntries(IMPORT_FIELDS.map((field) => [field, cell()])) as Record<
      ImportField,
      ReturnType<typeof cell>
    >,
  ),
});

function uniqueLines(lines: readonly { line: number }[], ctx: z.RefinementCtx) {
  const seen = new Set<number>();
  for (const { line } of lines) {
    if (seen.has(line)) {
      ctx.addIssue({ code: "custom", message: "duplicate_line" });
      return;
    }
    seen.add(line);
  }
}

/** `imports.customers.check`: the whole file. */
export const CheckCustomerImportInput = z.object({
  lines: z.array(ImportLineInput).min(1).max(IMPORT_LIMITS.rows).superRefine(uniqueLines),
});

/**
 * `imports.customers.apply`: one step of the import. Send whole customers (every line of a code
 * in the same step); a customer whose code already exists is skipped, so a split customer would
 * lose its later boxes.
 */
export const ApplyCustomerImportInput = z.object({
  lines: z
    .array(ImportLineInput)
    .min(1)
    .max(IMPORT_LIMITS.applyBatchLines)
    .superRefine(uniqueLines),
});

/**
 * - `ready` (check): the customer will be added.
 * - `created` (apply): it was added.
 * - `exists`: a customer with this code is already in the business. **Skipped**: nothing about
 *   that customer is changed (see the module notes in services.ts).
 * - `problem`: not added; `problems` says why (the other lines of the same customer say
 *   `same_customer`).
 */
export type ImportLineStatus = "ready" | "created" | "exists" | "problem";

export interface ImportCustomerRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface ImportLineResult {
  readonly line: number;
  readonly status: ImportLineStatus;
  /** The customer's position in the input (lines of one customer share it). */
  readonly group: number;
  readonly problems: readonly LineProblem[];
  /** `exists`: the customer already in the business. `created`: the new customer. */
  readonly customer: ImportCustomerRef | null;
  /** The line adds a connection (a VC). */
  readonly hasConnection: boolean;
}

export interface ImportCounts {
  /** Customers (groups of lines) by status. */
  readonly customers: Readonly<Record<ImportLineStatus, number>>;
  /** Connections that will be / were added. */
  readonly connections: number;
}

export interface ImportCheckResult {
  /** The day an empty start day stands for. */
  readonly today: BusinessDate;
  readonly lines: readonly ImportLineResult[];
  readonly counts: ImportCounts;
}

export type ImportApplyResult = ImportCheckResult;
