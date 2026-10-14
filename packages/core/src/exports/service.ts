/**
 * `exports.download` (T-082, FR-029, PLAN §9.3 "Exports (CSV): Owner only"): the gate and the audit
 * event of every export. Capability `exports.csv` (Owner only, audited), so Staff and linemen get
 * FORBIDDEN before anything is read. It checks the filters (the on-screen service's own input) and
 * that every id in them is this business's (another tenant's area, person, plan or customer is
 * NOT_FOUND, like a made-up one, and nothing is written), then records one audit event saying what
 * was downloaded with which filters. The rows themselves are read by `openExport` (./open.ts)
 * through the same services the pages use.
 *
 * Allowed in read-only mode (a read; D-13 "viewing"): the business's data stays theirs to take.
 */
import { areas, customers, plans, type Tx, users } from "@cb/db";
import { err, ok } from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import { type ExportCommand, ExportInput, type ExportKind, PAGING_KEYS } from "./kinds";

/** What a started export is: its kind, filters (paging removed) and the moment it started. */
export interface StartedExport {
  readonly kind: ExportKind;
  readonly filters: Readonly<Record<string, unknown>>;
  readonly startedAt: Date;
}

type IdTable = "area" | "user" | "plan" | "customer";

/** The ids a kind's filters can name, and what each must be. */
function filterIds(command: ExportCommand): [IdTable, string][] {
  const ids: [IdTable, string | undefined][] = [];
  switch (command.kind) {
    case "customers": {
      const { areaId } = command.filters;
      ids.push(["area", areaId === "none" ? undefined : areaId]);
      break;
    }
    case "bills":
    case "dues":
    case "billing_runs":
      ids.push(["area", command.filters.areaId]);
      break;
    case "payments":
      ids.push(["user", command.filters.collectorId], ["customer", command.filters.customerId]);
      break;
    case "collections":
      ids.push(["user", command.filters.collectorId]);
      break;
    case "handover":
      ids.push(["user", command.filters.linemanId]);
      break;
    case "connections": {
      const { areaId, plan } = command.filters;
      ids.push(["area", areaId], ["plan", plan === "own" ? undefined : plan]);
      break;
    }
  }
  return ids.filter((entry): entry is [IdTable, string] => entry[1] !== undefined);
}

async function belongs(tx: Tx, operatorId: string, table: IdTable, id: string): Promise<boolean> {
  const query = {
    area: () =>
      tx
        .select({ id: areas.id })
        .from(areas)
        .where(and(eq(areas.operatorId, operatorId), eq(areas.id, id))),
    user: () =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.operatorId, operatorId), eq(users.id, id))),
    plan: () =>
      tx
        .select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.operatorId, operatorId), eq(plans.id, id))),
    customer: () =>
      tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.operatorId, operatorId), eq(customers.id, id))),
  }[table];
  return (await query()).length > 0;
}

const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * The filters as the audit event keeps them: paging dropped, keys snake_case. The customer search
 * text is not kept (it may be a phone number); only that there was one.
 */
export function auditedFilters(command: ExportCommand): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(command.filters as Record<string, unknown>)) {
    if (value === undefined || (PAGING_KEYS as readonly string[]).includes(key)) continue;
    if (command.kind === "customers" && key === "q") {
      if (typeof value === "string" && value.trim() !== "") out.searched = true;
      continue;
    }
    out[snake(key)] = value;
  }
  return out;
}

function shownFilters(command: ExportCommand): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(command.filters as Record<string, unknown>)) {
    if (value !== undefined && !(PAGING_KEYS as readonly string[]).includes(key)) out[key] = value;
  }
  return out;
}

export const startExport = defineService({
  name: "exports.download",
  capability: "exports.csv",
  input: ExportInput,
  async run({ ctx, input, tx, audit, now }) {
    for (const [table, id] of filterIds(input)) {
      if (!(await belongs(tx, ctx.operatorId, table, id))) return err(notFound());
    }
    await audit.record({
      entityType: "export",
      // `report` (not `kind`): the dues filters have their own `kind` (due / advance).
      after: { report: input.kind, ...auditedFilters(input) },
    });
    const started: StartedExport = {
      kind: input.kind,
      filters: shownFilters(input),
      startedAt: now,
    };
    return ok(started);
  },
});
