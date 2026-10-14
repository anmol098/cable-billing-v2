/**
 * Turns import lines into a plan per customer (T-084): which customers are new and valid (with
 * the exact inputs `customers.create` and `connections.add` will get), which already exist
 * (skipped), and what is wrong with the rest. Reads only; the services decide what to do with it.
 *
 * Lookups are done once per call for all lines (codes, areas, plans, VCs), so checking 5,000
 * lines is a handful of queries. Every query runs in the caller's tenant transaction (RLS), and
 * names are matched only among the tenant's own areas and plans.
 */
import { areas, customers, plans, type Tx, vcAssets, vcAssignments } from "@cb/db";
import {
  addDays,
  type BusinessDate,
  businessDate,
  compareBusinessDates,
  formatINR,
  toPaise,
} from "@cb/domain";
import { and, eq, inArray } from "drizzle-orm";
import { ConnectionFields, type ConnectionFieldsCommand } from "../connections/inputs";
import type { CreateCustomerCommand } from "../customers/customers";
import type { ImportLine } from "./file";
import {
  type ConnectionDraft,
  type CustomerGroup,
  checkGroups,
  connectionDraftOf,
  customerInputOf,
  groupLines,
  hasConnection,
  LineProblems,
  spreadGroupProblems,
} from "./rules";
import type { ImportCustomerRef } from "./types";

/** A new customer that passed every check: what the services will be called with. */
export interface ReadyCustomer {
  readonly status: "ready";
  readonly group: CustomerGroup;
  readonly customer: CreateCustomerCommand;
  readonly connections: readonly {
    readonly line: number;
    readonly fields: ConnectionFieldsCommand;
  }[];
}

export type CustomerPlan =
  | ReadyCustomer
  | {
      readonly status: "exists";
      readonly group: CustomerGroup;
      readonly existing: ImportCustomerRef;
    }
  | { readonly status: "problem"; readonly group: CustomerGroup };

export interface ImportPlan {
  readonly customers: readonly CustomerPlan[];
  readonly problems: LineProblems;
}

/** Area / plan names compared as the unique indexes do: case and outer/double spaces ignored. */
export function nameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

const LOOKUP_CHUNK = 1000;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += LOOKUP_CHUNK)
    out.push(items.slice(at, at + LOOKUP_CHUNK));
  return out;
}

async function existingCustomers(
  tx: Tx,
  operatorId: string,
  codeKeys: readonly string[],
): Promise<Map<string, ImportCustomerRef>> {
  const found = new Map<string, ImportCustomerRef>();
  for (const part of chunks(codeKeys)) {
    const rows = await tx
      .select({
        id: customers.id,
        code: customers.customerCode,
        codeNorm: customers.customerCodeNorm,
        name: customers.name,
      })
      .from(customers)
      .where(and(eq(customers.operatorId, operatorId), inArray(customers.customerCodeNorm, part)));
    for (const row of rows) found.set(row.codeNorm, { id: row.id, code: row.code, name: row.name });
  }
  return found;
}

interface AreaRef {
  readonly id: string;
  readonly archived: boolean;
}

async function areasByName(tx: Tx, operatorId: string): Promise<Map<string, AreaRef>> {
  const rows = await tx
    .select({ id: areas.id, name: areas.name, archivedAt: areas.archivedAt })
    .from(areas)
    .where(eq(areas.operatorId, operatorId));
  return new Map(
    rows.map((row) => [nameKey(row.name), { id: row.id, archived: row.archivedAt !== null }]),
  );
}

interface PlanRef {
  readonly id: string;
  readonly active: boolean;
  readonly amountPaise: number;
}

async function plansByName(tx: Tx, operatorId: string): Promise<Map<string, PlanRef>> {
  const rows = await tx
    .select({
      id: plans.id,
      name: plans.name,
      status: plans.status,
      amount: plans.monthlyAmountPaise,
    })
    .from(plans)
    .where(eq(plans.operatorId, operatorId));
  const map = new Map<string, PlanRef>();
  for (const row of rows) {
    const key = nameKey(row.name);
    const ref = { id: row.id, active: row.status === "active", amountPaise: row.amount };
    // An active plan wins over retired ones with the same name.
    if (!map.get(key)?.active) map.set(key, ref);
  }
  return map;
}

interface VcHolder {
  readonly customerCode: string;
  readonly endDate: string | null;
  readonly startDate: string;
}

interface VcInfo {
  readonly retired: boolean;
  readonly assignments: readonly VcHolder[];
}

async function vcsByNumber(
  tx: Tx,
  operatorId: string,
  vcKeys: readonly string[],
): Promise<Map<string, VcInfo>> {
  const found = new Map<string, VcInfo>();
  for (const part of chunks(vcKeys)) {
    const assets = await tx
      .select({ id: vcAssets.id, norm: vcAssets.vcNumberNorm, lifecycle: vcAssets.lifecycleStatus })
      .from(vcAssets)
      .where(and(eq(vcAssets.operatorId, operatorId), inArray(vcAssets.vcNumberNorm, part)));
    if (assets.length === 0) continue;
    const rows = await tx
      .select({
        assetId: vcAssignments.vcAssetId,
        startDate: vcAssignments.startDate,
        endDate: vcAssignments.endDate,
        code: customers.customerCode,
      })
      .from(vcAssignments)
      .innerJoin(
        customers,
        and(
          eq(customers.operatorId, vcAssignments.operatorId),
          eq(customers.id, vcAssignments.customerId),
        ),
      )
      .where(
        and(
          eq(vcAssignments.operatorId, operatorId),
          inArray(
            vcAssignments.vcAssetId,
            assets.map((asset) => asset.id),
          ),
        ),
      );
    const byAsset = new Map<string, VcHolder[]>();
    for (const row of rows) {
      const list = byAsset.get(row.assetId) ?? [];
      list.push({ customerCode: row.code, endDate: row.endDate, startDate: row.startDate });
      byAsset.set(row.assetId, list);
    }
    for (const asset of assets) {
      found.set(asset.norm, {
        retired: asset.lifecycle !== "in_service",
        assignments: byAsset.get(asset.id) ?? [],
      });
    }
  }
  return found;
}

/** The assignment that still holds the VC on `from` (as `connections.add` checks it). */
function holderOn(info: VcInfo, from: BusinessDate): VcHolder | null {
  const holding = info.assignments
    .filter((a) => a.endDate === null || compareBusinessDates(businessDate(a.endDate), from) >= 0)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0));
  return holding[0] ?? null;
}

/** Resolves a connection draft's plan and VC; problems go to the draft's line. */
function resolveConnection(
  draft: ConnectionDraft,
  plansMap: ReadonlyMap<string, PlanRef>,
  vcs: ReadonlyMap<string, VcInfo>,
  problems: LineProblems,
): ConnectionFieldsCommand | null {
  const before = problems.of(draft.line).length;
  let planId: string | null = null;
  let rentalPaise: number | null = draft.rentPaise;
  if (draft.planName !== "") {
    const plan = plansMap.get(nameKey(draft.planName));
    if (!plan) {
      problems.add(draft.line, {
        field: "plan",
        code: "not_found",
        params: { plan: draft.planName },
      });
    } else if (!plan.active) {
      problems.add(draft.line, {
        field: "plan",
        code: "retired",
        params: { plan: draft.planName },
      });
    } else if (draft.rentPaise !== null && draft.rentPaise !== plan.amountPaise) {
      problems.add(draft.line, {
        field: "rent",
        code: "rent_differs",
        params: { amount: formatINR(toPaise(plan.amountPaise)) },
      });
    } else {
      planId = plan.id;
      rentalPaise = null;
    }
  }
  const vc = vcs.get(draft.vcKey);
  if (vc?.retired) {
    problems.add(draft.line, { field: "vcNumber", code: "retired" });
  } else if (vc) {
    const holder = holderOn(vc, draft.startDate);
    if (holder) {
      problems.add(draft.line, {
        field: "vcNumber",
        code: "in_use",
        params: {
          code: holder.customerCode,
          from: holder.endDate === null ? "" : addDays(businessDate(holder.endDate), 1),
        },
      });
    }
  }
  if (problems.of(draft.line).length > before) return null;
  const parsed = ConnectionFields.safeParse({
    vcNumber: draft.vcNumber,
    planId,
    rentalPaise,
    startDate: draft.startDate,
  });
  if (!parsed.success) {
    problems.add(draft.line, { field: "line", code: "invalid" });
    return null;
  }
  return parsed.data;
}

/** Builds the plan for `lines` (one service call's worth) in the caller's tenant transaction. */
export async function planImport(
  tx: Tx,
  operatorId: string,
  lines: readonly ImportLine[],
  today: BusinessDate,
): Promise<ImportPlan> {
  const groups = groupLines(lines);
  const problems = new LineProblems();
  checkGroups(groups, problems);

  const customerInputs = new Map<CustomerGroup, CreateCustomerCommand>();
  const drafts = new Map<CustomerGroup, ConnectionDraft[]>();
  for (const group of groups) {
    const [first] = group.lines;
    if (!first) continue;
    const customer = customerInputOf(first);
    if (customer.ok) customerInputs.set(group, customer.input);
    else for (const problem of customer.problems) problems.add(first.line, problem);
    const list: ConnectionDraft[] = [];
    for (const line of group.lines) {
      if (!hasConnection(line)) continue;
      const draft = connectionDraftOf(line, today);
      if (draft.ok) list.push(draft.draft);
      else for (const problem of draft.problems) problems.add(line.line, problem);
    }
    drafts.set(group, list);
  }

  const codeKeys = groups.map((group) => group.codeKey).filter((key) => key !== "");
  const vcKeys = [...new Set([...drafts.values()].flat().map((draft) => draft.vcKey))];
  const [existing, areaMap, planMap, vcMap] = [
    await existingCustomers(tx, operatorId, codeKeys),
    await areasByName(tx, operatorId),
    await plansByName(tx, operatorId),
    await vcsByNumber(tx, operatorId, vcKeys),
  ];

  const result: CustomerPlan[] = [];
  for (const group of groups) {
    const found = group.codeKey === "" ? undefined : existing.get(group.codeKey);
    if (found) {
      result.push({ status: "exists", group, existing: found });
      continue;
    }
    const [first] = group.lines;
    if (!first) continue;
    let areaId: string | null = null;
    const areaName = first.values.area;
    if (areaName !== "") {
      const area = areaMap.get(nameKey(areaName));
      if (!area)
        problems.add(first.line, { field: "area", code: "not_found", params: { area: areaName } });
      else if (area.archived)
        problems.add(first.line, { field: "area", code: "hidden", params: { area: areaName } });
      else areaId = area.id;
    }
    const connections: { line: number; fields: ConnectionFieldsCommand }[] = [];
    for (const draft of drafts.get(group) ?? []) {
      const fields = resolveConnection(draft, planMap, vcMap, problems);
      if (fields) connections.push({ line: draft.line, fields });
    }
    const input = customerInputs.get(group);
    if (spreadGroupProblems(group, problems) || !input) {
      result.push({ status: "problem", group });
      continue;
    }
    result.push({ status: "ready", group, customer: { ...input, areaId }, connections });
  }
  return { customers: result, problems };
}
