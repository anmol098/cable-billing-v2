/**
 * Customer import services (T-084; FR-030, PLAN §12.2 "Excel/CSV import").
 *
 * | Service | Capability | What |
 * |---|---|---|
 * | `imports.customers.check` | `customers.manage` (Owner, Staff) | The preview: every line's status and problems; writes nothing |
 * | `imports.customers.apply` | `customers.manage` | One import step (≤ 250 lines): adds the valid new customers with their connections |
 *
 * **No bypass.** Lines are checked with the services' own Zod inputs (`CreateCustomerInput`,
 * `ConnectionFields`) and saved by the services' own in-transaction functions
 * (`createCustomerInTx` → `customers.create`'s rules and audit event, `addConnectionInTx` →
 * `connections.add`'s rules, locks, hook and audit event), inside this service's tenant
 * transaction (role check, read-only mode, RLS). Area and plan names are matched only among the
 * tenant's own rows; nothing in a file can name another tenant's id.
 *
 * **One customer = all-or-nothing.** Each customer (all lines with its code) is saved in its own
 * savepoint: if the customer or any of its connections is refused, that savepoint is rolled back
 * and nothing of that customer stays; the other customers of the step are saved. A line with a
 * problem never imports partly.
 *
 * **Uploading the same file again** (idempotency): customers are matched on the customer code
 * (normalised as everywhere: spaces and letter case ignored). A code that already exists in the
 * business is **skipped: that customer and its connections are not changed** (status `exists`).
 * Why skip and not update: since the first upload the office or a lineman may have changed the
 * customer (a corrected phone number has history, a connection may have been stopped or the VC
 * moved); "updating" from an old spreadsheet would silently undo that, and changing connections
 * from a file would rewrite their history (PLAN §8.3). So a re-upload adds only the customers that
 * are missing (e.g. the lines that had problems, after fixing them, or a step that did not finish)
 * and never creates a duplicate. Changes to existing customers are made on their profile.
 */
import type { Tx } from "@cb/db";
import { businessDateOf, ok } from "@cb/domain";
import { createAuditRecorder } from "../audit/audit";
import { addConnectionInTx } from "../connections/services";
import { defineService } from "../context/service";
import type { TenantContext } from "../context/tenant-context";
import { createCustomerInTx, isDuplicateCustomerCode } from "../customers/customers";
import { isExpectedError, type ServiceError, toServiceError } from "../errors/errors";
import type { Logger } from "../logging/logger";
import type { ImportField } from "./columns";
import type { ImportLine } from "./file";
import { IMPORT_LIMITS } from "./limits";
import { type CustomerPlan, type ImportPlan, planImport, type ReadyCustomer } from "./plan";
import { hasConnection, type LineProblem, type LineProblemCode, type LineProblems } from "./rules";
import {
  ApplyCustomerImportInput,
  CheckCustomerImportInput,
  type ImportCheckResult,
  type ImportCounts,
  type ImportCustomerRef,
  type ImportLineResult,
  type ImportLineStatus,
  type ImportPreview,
} from "./types";

function emptyCounts(): Record<ImportLineStatus, number> {
  return { ready: 0, created: 0, exists: 0, problem: 0 };
}

function resultFor(
  plans: readonly CustomerPlan[],
  problems: LineProblems,
  outcome: (plan: CustomerPlan) => { status: ImportLineStatus; customer: ImportCustomerRef | null },
): { lines: ImportLineResult[]; counts: ImportCounts } {
  const lines: ImportLineResult[] = [];
  const customers = emptyCounts();
  let connections = 0;
  plans.forEach((plan, group) => {
    const { status, customer } = outcome(plan);
    customers[status] += 1;
    for (const line of plan.group.lines) {
      const connection = hasConnection(line);
      if (connection && (status === "ready" || status === "created")) connections += 1;
      lines.push({
        line: line.line,
        status,
        group,
        problems: status === "problem" ? problems.of(line.line) : [],
        customer,
        hasConnection: connection,
      });
    }
  });
  lines.sort((a, b) => a.line - b.line);
  return { lines, counts: { customers, connections } };
}

const FIELD_OF_PATH: Readonly<Record<string, ImportField>> = {
  customerCode: "code",
  name: "name",
  phone: "phone",
  altPhone: "altPhone",
  address: "address",
  areaId: "area",
  vcNumber: "vcNumber",
  planId: "plan",
  rentalPaise: "rent",
  startDate: "startDate",
};

const KNOWN_FIELD_CODES = new Set<LineProblemCode>(["in_future", "too_old", "retired"]);

/** A service's refusal → the problem shown on the line it belongs to. */
export function problemFromServiceError(error: ServiceError<string>): LineProblem {
  const details = error.details ?? {};
  if (error.code === "VALIDATION" && Array.isArray(details.fields)) {
    const [first] = details.fields as { path?: string; code?: string }[];
    const field =
      FIELD_OF_PATH[
        String(first?.path ?? "")
          .split(".")
          .pop() ?? ""
      ];
    const code = String(first?.code ?? "");
    if (field) {
      return {
        field,
        code: KNOWN_FIELD_CODES.has(code as LineProblemCode)
          ? (code as LineProblemCode)
          : code === "archived"
            ? "hidden"
            : "invalid",
      };
    }
  }
  if (error.code === "CONFLICT") {
    switch (details.reason) {
      case "vc_in_use":
        return {
          field: "vcNumber",
          code: "in_use",
          params: {
            code: String(details.holderCustomerCode ?? ""),
            from: String(details.earliestStart ?? ""),
          },
        };
      case "vc_retired":
        return { field: "vcNumber", code: "retired" };
      case "billed_period":
        return { field: "startDate", code: "billed_period" };
      default:
        if (details.constraint === "vc_assignments_no_overlap") {
          return { field: "vcNumber", code: "in_use", params: { code: "", from: "" } };
        }
    }
  }
  return { field: "line", code: "not_saved" };
}

/** Thrown inside a customer's savepoint to roll it back. */
class CustomerRollback {
  constructor(
    readonly error: ServiceError<string>,
    /** The line the error belongs to. */
    readonly line: number,
  ) {}
}

interface SaveEnv {
  readonly ctx: TenantContext;
  readonly now: Date;
  readonly log: Logger;
}

type SaveOutcome =
  | { readonly status: "created"; readonly customer: ImportCustomerRef }
  | { readonly status: "exists"; readonly customer: ImportCustomerRef | null }
  | { readonly status: "problem" };

/** Saves one ready customer and its connections in a savepoint: all or nothing. */
async function saveCustomer(
  tx: Tx,
  env: SaveEnv,
  plan: ReadyCustomer,
  problems: LineProblems,
): Promise<SaveOutcome> {
  const firstLine = plan.group.lines[0]?.line ?? 0;
  try {
    const customer = await tx.transaction(async (savepoint) => {
      // The same audit events as "Add customer": `customers.create` and `connections.add`.
      const audit = createAuditRecorder(savepoint, env.ctx, "customers.create");
      const created = await createCustomerInTx(savepoint, env.ctx, plan.customer, env.now, audit);
      if (!created.ok) throw new CustomerRollback(created.error, firstLine);
      const customerId = created.value.customer.id;
      for (const connection of plan.connections) {
        const added = await addConnectionInTx(
          savepoint,
          { ctx: env.ctx, now: env.now, audit, log: env.log },
          { ...connection.fields, customerId },
        );
        if (!added.ok) throw new CustomerRollback(added.error, connection.line);
      }
      return created.value.customer;
    });
    return {
      status: "created",
      customer: { id: customer.id, code: customer.customerCode, name: customer.name },
    };
  } catch (error) {
    const refusal =
      error instanceof CustomerRollback
        ? error
        : new CustomerRollback(toServiceError(error), firstLine);
    if (!(error instanceof CustomerRollback) && !isExpectedError(refusal.error.code)) {
      // A bug or a broken connection: fail the whole step (its transaction rolls back).
      throw error;
    }
    if (isDuplicateCustomerCode(refusal.error)) {
      // Added by someone else since the check: the same as a re-upload, skipped.
      return { status: "exists", customer: null };
    }
    problems.add(refusal.line, problemFromServiceError(refusal.error));
    for (const line of plan.group.lines) {
      if (line.line !== refusal.line) {
        problems.add(line.line, {
          field: "line",
          code: "same_customer",
          params: { lines: String(refusal.line) },
        });
      }
    }
    return { status: "problem" };
  }
}

function linesOf(input: { lines: readonly ImportLine[] }): readonly ImportLine[] {
  return input.lines;
}

/**
 * The preview (PLAN §12.2 "preview with errors highlighted per row"): every line's status and
 * problems, without writing anything. `customers.manage`, so it also refuses Staff in read-only
 * mode early (the import itself would be refused).
 */
export const checkCustomerImport = defineService({
  name: "imports.customers.check",
  capability: "customers.manage",
  input: CheckCustomerImportInput,
  async run({ input, tx, ctx, audit, now }) {
    const today = businessDateOf(now);
    const plan: ImportPlan = await planImport(tx, ctx.operatorId, linesOf(input), today);
    audit.skip("no_change");
    const { lines, counts } = resultFor(plan.customers, plan.problems, (customer) => ({
      status: customer.status,
      customer: customer.status === "exists" ? customer.existing : null,
    }));
    const value: ImportPreview = { today, lines, counts, steps: importSteps(lines) };
    return ok(value);
  },
});

/**
 * Splits the ready lines into import steps: whole customers (all lines of one `group`) per
 * step, at most `max` lines (a customer has at most 11 lines, so it always fits).
 */
export function importSteps(
  lines: readonly ImportLineResult[],
  max: number = IMPORT_LIMITS.applyBatchLines,
): number[][] {
  const groups = new Map<number, number[]>();
  for (const line of lines) {
    if (line.status !== "ready") continue;
    const list = groups.get(line.group) ?? [];
    list.push(line.line);
    groups.set(line.group, list);
  }
  const steps: number[][] = [];
  let current: number[] = [];
  for (const group of [...groups.keys()].sort((a, b) => a - b)) {
    const groupLines = groups.get(group) ?? [];
    if (current.length > 0 && current.length + groupLines.length > max) {
      steps.push(current);
      current = [];
    }
    current.push(...groupLines);
  }
  if (current.length > 0) steps.push(current);
  return steps;
}

/**
 * One import step: checks the lines again (the data may have changed since the preview) and saves
 * every valid new customer with its connections, each in its own savepoint. Records one
 * `imports.customers.apply` audit event with the counts (no names or numbers) besides the
 * per-customer events.
 */
export const applyCustomerImport = defineService({
  name: "imports.customers.apply",
  capability: "customers.manage",
  input: ApplyCustomerImportInput,
  async run({ input, tx, ctx, audit, log, now }) {
    const today = businessDateOf(now);
    const plan = await planImport(tx, ctx.operatorId, linesOf(input), today);
    const outcomes = new Map<CustomerPlan, SaveOutcome>();
    for (const customer of plan.customers) {
      if (customer.status !== "ready") continue;
      outcomes.set(customer, await saveCustomer(tx, { ctx, now, log }, customer, plan.problems));
    }
    const { lines, counts } = resultFor(plan.customers, plan.problems, (customer) => {
      if (customer.status === "exists") return { status: "exists", customer: customer.existing };
      if (customer.status === "problem") return { status: "problem", customer: null };
      const saved = outcomes.get(customer);
      if (!saved) return { status: "problem", customer: null };
      return {
        status: saved.status,
        customer: saved.status === "problem" ? null : saved.customer,
      };
    });
    if (counts.customers.created > 0) {
      await audit.record({
        action: "imports.customers.apply",
        entityType: "customer_import",
        after: {
          lines: lines.length,
          created: counts.customers.created,
          connections: counts.connections,
          skipped: counts.customers.exists,
          problems: counts.customers.problem,
        },
      });
    } else {
      audit.skip("no_change");
    }
    log.info("imports.customers.applied", {
      lines: lines.length,
      created: counts.customers.created,
      skipped: counts.customers.exists,
      problems: counts.customers.problem,
    });
    const value: ImportCheckResult = { today, lines, counts };
    return ok(value);
  },
});
