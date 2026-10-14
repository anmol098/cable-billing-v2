/**
 * Mobile sync services (T-060; PLAN §10.3, FR-004, B-012, D-11). All read with `customers.view`
 * (Owner, Staff, Lineman; READ ONLY, never audited, allowed in read-only mode). D-11: a lineman
 * may collect from **any** customer of the operator, so the roster is the whole tenant (no area or
 * assignment filter).
 *
 * | Service | What |
 * |---|---|
 * | `mobile_sync.roster` | One page of the roster delta (`GET /sync/customers`) |
 * | `mobile_sync.customer_detail` | One customer with open bills and recent payments (`GET /customers/{id}`) |
 * | `mobile_sync.roster_customer` | One roster row (the answer of `PATCH /customers/{id}/phone`) |
 *
 * Each runs in one REPEATABLE READ transaction, so a page's rows, its tombstones and the snapshot
 * xmin stored in the cursor all come from the same snapshot (see ./cursor.ts for why the cursor is
 * built on transaction ids). The phone update itself is T-033's `customers.update_phone`.
 */
import { err, ok } from "@cb/domain";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import { notFound, serviceError } from "../errors/errors";
import {
  cursorIsFromTheFuture,
  decodeCursor,
  encodeCursor,
  fullSyncCursor,
  minXid,
  type RosterCursor,
} from "./cursor";
import { loadOpenBills, loadRecentPayments, loadRosterRows } from "./rows";
import type { RosterCustomerDetail, RosterPage, RosterRow } from "./types";

/** Rows (customers + tombstones) per page by default and at most (contract `ROSTER_PAGE_MAX`). */
export const ROSTER_PAGE_SIZE = 500;

const id = () => z.uuid().transform((value) => value.toLowerCase());

export const SyncRosterInput = z.object({
  /** The `next_cursor` of the previous page or sync; absent = a full sync from the start. */
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(ROSTER_PAGE_SIZE).default(ROSTER_PAGE_SIZE),
});
export type SyncRosterCommand = z.output<typeof SyncRosterInput>;

interface SnapshotRow extends Record<string, unknown> {
  xmin: string;
  xmax: string;
}

interface PageSqlRow extends Record<string, unknown> {
  id: string;
  xid: string;
  status: "active" | "inactive";
}

const cursorInvalid = (reason: string) =>
  serviceError("CURSOR_INVALID", "cursor is not valid here; start a full sync", { reason });

/** Order of the customers inside one page: `(updated_at, id)` (the contract's wording). */
function byUpdatedAt(a: RosterRow, b: RosterRow): number {
  const diff = a.updatedAt.getTime() - b.updatedAt.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const syncRoster = defineService<typeof SyncRosterInput, RosterPage, "CURSOR_INVALID">({
  name: "mobile_sync.roster",
  capability: "customers.view",
  input: SyncRosterInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx, log }) {
    const operatorId = ctx.operatorId.toLowerCase();
    let cursor: RosterCursor;
    if (input.cursor === undefined) {
      cursor = fullSyncCursor(operatorId);
    } else {
      const decoded = decodeCursor(input.cursor);
      if (decoded === null) return err(cursorInvalid("malformed"));
      if (decoded.operatorId !== operatorId) return err(cursorInvalid("other_operator"));
      cursor = decoded;
    }

    // The transaction's snapshot (REPEATABLE READ: the same for every statement below).
    const snapshot = await tx.execute<SnapshotRow>(sql`
      SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin,
        pg_snapshot_xmax(pg_current_snapshot())::text AS xmax`);
    const snap = snapshot.rows[0];
    if (!snap) throw new Error("no snapshot");
    if (cursorIsFromTheFuture(cursor, snap.xmax)) return err(cursorInvalid("from_the_future"));

    const after = cursor.after;
    const page = await tx.execute<PageSqlRow>(sql`
      SELECT v.customer_id AS id, v.change_xid::text AS xid, c.status
      FROM roster_versions v
      JOIN customers c ON c.operator_id = v.operator_id AND c.id = v.customer_id
      WHERE v.operator_id = ${operatorId}::uuid
        AND v.change_xid >= ${cursor.watermark}::xid8
        ${after ? sql`AND (v.change_xid, v.customer_id) > (${after[0]}::xid8, ${after[1]}::uuid)` : sql``}
        ${cursor.full ? sql`AND c.status = 'active'` : sql``}
      ORDER BY v.change_xid, v.customer_id
      LIMIT ${input.limit + 1}`);

    const hasMore = page.rows.length > input.limit;
    const rows = hasMore ? page.rows.slice(0, input.limit) : page.rows;
    const activeIds = rows.filter((r) => r.status === "active").map((r) => r.id);
    const removedCustomerIds = cursor.full
      ? []
      : rows.filter((r) => r.status !== "active").map((r) => r.id);
    const loaded = await loadRosterRows(tx, operatorId, activeIds);
    const customers = activeIds
      .map((rowId) => loaded.get(rowId))
      .filter((row): row is RosterRow => row !== undefined)
      .sort(byUpdatedAt);

    const nextWatermark =
      cursor.nextWatermark === undefined ? snap.xmin : minXid(cursor.nextWatermark, snap.xmin);
    const last = rows.at(-1);
    const next: RosterCursor =
      hasMore && last
        ? {
            operatorId,
            watermark: cursor.watermark,
            nextWatermark,
            after: [last.xid, last.id],
            full: cursor.full,
          }
        : { operatorId, watermark: nextWatermark, full: false };

    log.info("mobile_sync.roster_page", {
      full: cursor.full,
      first_page: cursor.after === undefined,
      customers: customers.length,
      removed: removedCustomerIds.length,
      has_more: hasMore,
    });
    return ok({ customers, removedCustomerIds, nextCursor: encodeCursor(next), hasMore });
  },
});

export const RosterCustomerInput = z.object({ customerId: id() });

export const getRosterCustomerDetail = defineService({
  name: "mobile_sync.customer_detail",
  capability: "customers.view",
  input: RosterCustomerInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx }) {
    const operatorId = ctx.operatorId.toLowerCase();
    const customer = (await loadRosterRows(tx, operatorId, [input.customerId])).get(
      input.customerId,
    );
    if (!customer) return err(notFound());
    const detail: RosterCustomerDetail = {
      customer,
      openBills: await loadOpenBills(tx, operatorId, customer.id),
      recentPayments: await loadRecentPayments(tx, operatorId, customer.id),
    };
    return ok(detail);
  },
});

export const getRosterCustomer = defineService({
  name: "mobile_sync.roster_customer",
  capability: "customers.view",
  input: RosterCustomerInput,
  async run({ ctx, input, tx }) {
    const customer = (
      await loadRosterRows(tx, ctx.operatorId.toLowerCase(), [input.customerId])
    ).get(input.customerId);
    return customer ? ok(customer) : err(notFound());
  },
});
