/**
 * Connection reads (T-034; FR-006 "full status and plan timeline").
 *
 * | Service | Capability | What |
 * |---|---|---|
 * | `connections.list` | `customers.view` (Owner, Staff, Lineman) | A customer's connections with their timelines, what may be done to each, and the earliest allowed change date |
 * | `connections.form_options` | `dashboard.view` (Owner, Staff) | Active plans, today, the latest start date, and (for a customer) the earliest start date |
 *
 * Both run in a READ ONLY transaction. Another tenant's customer id → NOT_FOUND.
 */
import { customers, plans, type Tx } from "@cb/db";
import {
  type AssignmentStatusOnDate,
  assignmentStatusOn,
  type BusinessDate,
  businessDateOf,
  err,
  ok,
  validateAssignmentTimeline,
} from "@cb/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import { ConnectionFormOptionsInput, ListConnectionsInput } from "./inputs";
import { allowedActions, earliestAllowedDate, latestStartDate, parseStopReason } from "./rules";
import { lastChangeDate, latestBilledPeriod, toTimeline } from "./store";
import type {
  ConnectionDetail,
  ConnectionEventView,
  ConnectionFormOptions,
  CustomerConnections,
} from "./types";

interface AssignmentListRow extends Record<string, unknown> {
  id: string;
  vc_asset_id: string;
  vc_number: string;
  status: ConnectionDetail["status"];
  plan_id: string | null;
  plan_name: string | null;
  rental_amount_paise: string | number;
  start_date: string;
  end_date: string | null;
  history_limited: boolean;
}

interface EventListRow extends Record<string, unknown> {
  id: string;
  assignment_id: string;
  type: ConnectionEventView["type"];
  effective_date: string;
  at: Date | string;
  reason: string | null;
  actor_name: string | null;
  from_plan_name: string | null;
  to_plan_name: string | null;
  from_rental_paise: string | number | null;
  to_rental_paise: string | number | null;
}

const numberOrNull = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

function maxDate(...dates: (string | null)[]): string {
  let latest = "";
  for (const date of dates) if (date !== null && date > latest) latest = date;
  return latest;
}

/** The status during `today`, from the timeline; the stored status if the history is odd. */
function statusToday(
  row: AssignmentListRow,
  events: readonly EventListRow[],
  today: BusinessDate,
): AssignmentStatusOnDate {
  const timeline = toTimeline(
    { startDate: row.start_date, endDate: row.end_date },
    events.map((e) => ({
      type: e.type,
      effectiveDate: e.effective_date,
      toRentalPaise: numberOrNull(e.to_rental_paise),
    })),
  );
  if (!validateAssignmentTimeline(timeline).ok) return row.status;
  return assignmentStatusOn(timeline, today);
}

async function customerExists(tx: Tx, operatorId: string, customerId: string) {
  const [row] = await tx
    .select({ id: customers.id, status: customers.status })
    .from(customers)
    .where(and(eq(customers.operatorId, operatorId), eq(customers.id, customerId)));
  return row ?? null;
}

export const listConnections = defineService({
  name: "connections.list",
  capability: "customers.view",
  input: ListConnectionsInput,
  async run({ ctx, input, tx, now }) {
    const op = ctx.operatorId;
    const customer = await customerExists(tx, op, input.customerId);
    if (!customer) return err(notFound());
    const today = businessDateOf(now);
    const latest = await latestBilledPeriod(tx, op, customer.id);

    const assignments = await tx.execute<AssignmentListRow>(sql`
      SELECT s.id, s.vc_asset_id, v.vc_number, s.status, s.plan_id, p.name AS plan_name,
        s.rental_amount_paise, s.start_date::text AS start_date, s.end_date::text AS end_date,
        s.history_limited
      FROM vc_assignments s
      JOIN vc_assets v ON v.operator_id = s.operator_id AND v.id = s.vc_asset_id
      LEFT JOIN plans p ON p.operator_id = s.operator_id AND p.id = s.plan_id
      WHERE s.operator_id = ${op}::uuid AND s.customer_id = ${customer.id}::uuid
      ORDER BY s.start_date DESC, s.id DESC`);
    const events = await tx.execute<EventListRow>(sql`
      SELECT e.id, e.assignment_id, e.type, e.effective_date::text AS effective_date, e.at,
        e.reason, u.name AS actor_name, fp.name AS from_plan_name, tp.name AS to_plan_name,
        e.from_rental_paise, e.to_rental_paise
      FROM assignment_events e
      JOIN vc_assignments s ON s.operator_id = e.operator_id AND s.id = e.assignment_id
      LEFT JOIN users u ON u.id = e.actor_id
      LEFT JOIN plans fp ON fp.operator_id = e.operator_id AND fp.id = e.from_plan_id
      LEFT JOIN plans tp ON tp.operator_id = e.operator_id AND tp.id = e.to_plan_id
      WHERE e.operator_id = ${op}::uuid AND s.customer_id = ${customer.id}::uuid
      ORDER BY e.at, e.id`);

    const byAssignment = new Map<string, EventListRow[]>();
    for (const event of events.rows) {
      const list = byAssignment.get(event.assignment_id) ?? [];
      list.push(event);
      byAssignment.set(event.assignment_id, list);
    }

    const details = assignments.rows.map((row): ConnectionDetail => {
      const rowEvents = byAssignment.get(row.id) ?? [];
      const actions = allowedActions(row.status);
      return {
        assignmentId: row.id,
        vcAssetId: row.vc_asset_id,
        vcNumber: row.vc_number,
        status: row.status,
        statusToday: statusToday(row, rowEvents, today),
        planId: row.plan_id,
        planName: row.plan_name,
        rentalPaise: Number(row.rental_amount_paise),
        startDate: row.start_date,
        endDate: row.end_date,
        historyLimited: Boolean(row.history_limited),
        actions,
        earliestChangeDate: maxDate(
          row.start_date,
          lastChangeDate(
            row.start_date,
            rowEvents.map((e) => ({ effectiveDate: e.effective_date })),
          ),
          earliestAllowedDate(latest),
        ),
        events: rowEvents.map(
          (e): ConnectionEventView => ({
            id: e.id,
            type: e.type,
            effectiveDate: e.effective_date,
            at: e.at instanceof Date ? e.at : new Date(e.at),
            reason: parseStopReason(e.reason),
            actorName: e.actor_name,
            fromPlanName: e.from_plan_name,
            toPlanName: e.to_plan_name,
            fromRentalPaise: numberOrNull(e.from_rental_paise),
            toRentalPaise: numberOrNull(e.to_rental_paise),
          }),
        ),
      };
    });

    const value: CustomerConnections = {
      customerId: customer.id,
      customerActive: customer.status === "active",
      today,
      latestBilledPeriod: latest,
      current: details.filter((d) => d.status !== "disconnected"),
      past: details
        .filter((d) => d.status === "disconnected")
        .sort((a, b) => maxDate(b.endDate).localeCompare(maxDate(a.endDate))),
    };
    return ok(value);
  },
});

export const connectionFormOptions = defineService({
  name: "connections.form_options",
  capability: "dashboard.view",
  input: ConnectionFormOptionsInput,
  async run({ ctx, input, tx, now }) {
    const op = ctx.operatorId;
    let earliestStartDate: string | null = null;
    if (input.customerId) {
      const customer = await customerExists(tx, op, input.customerId);
      if (!customer) return err(notFound());
      earliestStartDate = earliestAllowedDate(await latestBilledPeriod(tx, op, customer.id));
    }
    const rows = await tx
      .select({ id: plans.id, name: plans.name, monthlyAmountPaise: plans.monthlyAmountPaise })
      .from(plans)
      .where(and(eq(plans.operatorId, op), eq(plans.status, "active")))
      .orderBy(asc(plans.monthlyAmountPaise), asc(plans.name), asc(plans.id));
    const today = businessDateOf(now);
    const value: ConnectionFormOptions = {
      plans: rows.map((p) => ({
        id: p.id,
        name: p.name,
        monthlyAmountPaise: Number(p.monthlyAmountPaise),
      })),
      today,
      latestStartDate: latestStartDate(today),
      earliestStartDate,
    };
    return ok(value);
  },
});
