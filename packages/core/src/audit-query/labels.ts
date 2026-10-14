/**
 * Names for the things audit events are about (T-035): "customer 1045", "VC 123456", "receipt
 * R-2610-00045", "Ramesh", "Oct 2026". Looked up in one query per entity type for the page shown,
 * inside the caller's tenant transaction (RLS and an explicit `operator_id` filter), so another
 * tenant's row can never lend its name. A row that no longer exists (a purged receipt link) has
 * no name; the sentence then says so.
 *
 * Only business identifiers come back: codes, numbers, names, months. Never a phone or email.
 */
import {
  areas,
  billingRuns,
  collectionSessions,
  customers,
  devices,
  payments,
  plans,
  receiptLinks,
  receipts,
  type Tx,
  users,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { and, eq, inArray } from "drizzle-orm";
import type { AuditValue } from "./actions";

/** What a sentence says about the event's entity. */
export interface AuditEntityLabel {
  /** The entity's own name: a customer code, a VC number, a receipt number, a person, a month. */
  readonly target: AuditValue;
  /** Context: the customer of a connection or payment, the day of a cash handover. */
  readonly extra?: Readonly<Record<string, AuditValue>>;
}

export interface AuditEntityRef {
  readonly entityType: string;
  readonly entityId: string | null;
}

const text = (value: string): AuditValue => ({ kind: "text", value });

type Lookup = (tx: Tx, operatorId: string, ids: string[]) => Promise<Map<string, AuditEntityLabel>>;

const LOOKUPS: Readonly<Record<string, Lookup>> = {
  async customer(tx, op, ids) {
    const rows = await tx
      .select({ id: customers.id, code: customers.customerCode })
      .from(customers)
      .where(and(eq(customers.operatorId, op), inArray(customers.id, ids)));
    return new Map(rows.map((r) => [r.id, { target: text(r.code) }]));
  },
  async user(tx, op, ids) {
    const rows = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.operatorId, op), inArray(users.id, ids)));
    return new Map(rows.map((r) => [r.id, { target: text(r.name) }]));
  },
  async plan(tx, op, ids) {
    const rows = await tx
      .select({ id: plans.id, name: plans.name })
      .from(plans)
      .where(and(eq(plans.operatorId, op), inArray(plans.id, ids)));
    return new Map(rows.map((r) => [r.id, { target: text(r.name) }]));
  },
  async area(tx, op, ids) {
    const rows = await tx
      .select({ id: areas.id, name: areas.name })
      .from(areas)
      .where(and(eq(areas.operatorId, op), inArray(areas.id, ids)));
    return new Map(rows.map((r) => [r.id, { target: text(r.name) }]));
  },
  async vc_assignment(tx, op, ids) {
    const rows = await tx
      .select({ id: vcAssignments.id, vc: vcAssets.vcNumber, customer: customers.customerCode })
      .from(vcAssignments)
      .innerJoin(
        vcAssets,
        and(
          eq(vcAssets.operatorId, vcAssignments.operatorId),
          eq(vcAssets.id, vcAssignments.vcAssetId),
        ),
      )
      .innerJoin(
        customers,
        and(
          eq(customers.operatorId, vcAssignments.operatorId),
          eq(customers.id, vcAssignments.customerId),
        ),
      )
      .where(and(eq(vcAssignments.operatorId, op), inArray(vcAssignments.id, ids)));
    return new Map(
      rows.map((r) => [r.id, { target: text(r.vc), extra: { customer: text(r.customer) } }]),
    );
  },
  async payment(tx, op, ids) {
    const rows = await tx
      .select({
        id: payments.id,
        receipt: receipts.receiptNumber,
        customer: customers.customerCode,
      })
      .from(payments)
      .innerJoin(
        customers,
        and(eq(customers.operatorId, payments.operatorId), eq(customers.id, payments.customerId)),
      )
      .leftJoin(
        receipts,
        and(eq(receipts.operatorId, payments.operatorId), eq(receipts.paymentId, payments.id)),
      )
      .where(and(eq(payments.operatorId, op), inArray(payments.id, ids)));
    return new Map(
      rows.map((r) => [
        r.id,
        { target: text(r.receipt ?? "—"), extra: { customer: text(r.customer) } },
      ]),
    );
  },
  async receipt(tx, op, ids) {
    const rows = await tx
      .select({ id: receipts.id, number: receipts.receiptNumber })
      .from(receipts)
      .where(and(eq(receipts.operatorId, op), inArray(receipts.id, ids)));
    return new Map(rows.map((r) => [r.id, { target: text(r.number) }]));
  },
  async receipt_link(tx, op, ids) {
    const rows = await tx
      .select({ id: receiptLinks.id, number: receipts.receiptNumber })
      .from(receiptLinks)
      .innerJoin(
        receipts,
        and(
          eq(receipts.operatorId, receiptLinks.operatorId),
          eq(receipts.id, receiptLinks.receiptId),
        ),
      )
      .where(and(eq(receiptLinks.operatorId, op), inArray(receiptLinks.id, ids)));
    return new Map(rows.map((r) => [r.id, { target: text(r.number) }]));
  },
  async device(tx, op, ids) {
    const rows = await tx
      .select({ id: devices.id, model: devices.model, code: devices.deviceCode })
      .from(devices)
      .where(and(eq(devices.operatorId, op), inArray(devices.id, ids)));
    return new Map(
      rows.map((r) => [
        r.id,
        { target: text(r.model ? `${r.model.slice(0, 40)} (${r.code})` : r.code) },
      ]),
    );
  },
  async collection_session(tx, op, ids) {
    const rows = await tx
      .select({
        id: collectionSessions.id,
        name: users.name,
        date: collectionSessions.businessDate,
      })
      .from(collectionSessions)
      .innerJoin(
        users,
        and(
          eq(users.operatorId, collectionSessions.operatorId),
          eq(users.id, collectionSessions.collectorId),
        ),
      )
      .where(and(eq(collectionSessions.operatorId, op), inArray(collectionSessions.id, ids)));
    return new Map(
      rows.map((r) => [
        r.id,
        { target: text(r.name), extra: { date: { kind: "date", value: r.date } } },
      ]),
    );
  },
  async billing_run(tx, op, ids) {
    const rows = await tx
      .select({ id: billingRuns.id, period: billingRuns.period })
      .from(billingRuns)
      .where(and(eq(billingRuns.operatorId, op), inArray(billingRuns.id, ids)));
    return new Map(rows.map((r) => [r.id, { target: { kind: "period", value: r.period } }]));
  },
};

/** `entityType:entityId` → label, for the events of one page. */
export async function loadEntityLabels(
  tx: Tx,
  operatorId: string,
  refs: readonly AuditEntityRef[],
): Promise<Map<string, AuditEntityLabel>> {
  const idsByType = new Map<string, Set<string>>();
  for (const { entityType, entityId } of refs) {
    if (!entityId || !Object.hasOwn(LOOKUPS, entityType)) continue;
    const set = idsByType.get(entityType) ?? new Set<string>();
    set.add(entityId);
    idsByType.set(entityType, set);
  }
  const out = new Map<string, AuditEntityLabel>();
  for (const [entityType, ids] of idsByType) {
    const lookup = LOOKUPS[entityType];
    if (!lookup) continue;
    const found = await lookup(tx, operatorId, [...ids]);
    for (const [id, label] of found) out.set(`${entityType}:${id}`, label);
  }
  return out;
}
