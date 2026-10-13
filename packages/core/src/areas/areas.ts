/**
 * Areas (T-030, PLAN §12.1 Settings): the parts of town the operator's linemen cover. Customers
 * point at an area (`customers.area_id`, T-022); reports and the customer list filter by it.
 *
 * - `areas.list` (`dashboard.view`: Owner and Staff): every area with how many customers use it,
 *   and whether this user may change areas (Owner, tenant writable).
 * - `areas.create`, `areas.rename`, `areas.archive`, `areas.restore` (`business_profile.manage`:
 *   Owner only, audited, refused in read-only mode).
 *
 * **There is no delete.** An area is fixed by renaming it, and taken out of use by archiving
 * ("Hide"): an archived area disappears from the pickers (add/edit customer, filters for new
 * work) but its customers keep it, and old reports, imports (T-084, matched by name) and the
 * audit history ("Who changed what", which names the area's id) keep pointing at a real row.
 * Archiving can be undone (`areas.restore`); a delete could not, and an area that is "unused"
 * now can be picked by a customer being added at the same moment. For the user an unused hidden
 * area and a deleted one look the same, so delete would only add a destructive button
 * (PLAN §2.2 rule 6).
 *
 * Names are unique per operator, ignoring case (`areas_operator_name_unique`, archived areas
 * included): adding or renaming to a taken name gives CONFLICT with `details.reason` =
 * `name_taken` and `details.archived` (true: "show the hidden one again instead").
 */
import { areas, customers, type Tx, uuidv7 } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, asc, count, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import { notFound, type ServiceError, serviceError } from "../errors/errors";
import { type SettingsAccess, settingsAccess } from "../operators/access";
import { requiredLine } from "../operators/text";

/** Longest area name. */
export const AREA_NAME_MAX = 60;

/** An area name: one line, spaces collapsed, 1–60 characters. */
export const AreaName = requiredLine(AREA_NAME_MAX);

export interface AreaView {
  readonly id: string;
  readonly name: string;
  /** Set when the area is hidden from pickers; null when in use. */
  readonly archivedAt: Date | null;
  /** Customers whose area this is (active or not). */
  readonly customerCount: number;
}

export interface AreaListView extends SettingsAccess {
  /** Areas in use first, then archived ones; each group by name (ignoring case). */
  readonly areas: readonly AreaView[];
}

/** A name already used by another area of this operator. */
export type AreaNameTaken = ServiceError<"CONFLICT">;

const areaColumns = { id: areas.id, name: areas.name, archivedAt: areas.archivedAt };

async function customerCountOf(tx: Tx, areaId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(customers).where(eq(customers.areaId, areaId));
  return row?.n ?? 0;
}

/** CONFLICT `name_taken` when another area (any state) already has this name, ignoring case. */
async function checkNameFree(
  tx: Tx,
  name: string,
  exceptId?: string,
): Promise<Result<void, AreaNameTaken>> {
  const [clash] = await tx
    .select({ archivedAt: areas.archivedAt })
    .from(areas)
    .where(
      and(
        sql`lower(${areas.name}) = lower(${name})`,
        exceptId === undefined ? undefined : ne(areas.id, exceptId),
      ),
    )
    .limit(1);
  if (!clash) return ok(undefined);
  return err(
    serviceError("CONFLICT", "Another area already has this name", {
      reason: "name_taken",
      archived: clash.archivedAt !== null,
    }),
  );
}

/** Every area of the tenant with its customer count, and whether this user may change them. */
export const listAreas = defineService({
  name: "areas.list",
  capability: "dashboard.view",
  input: z.object({
    /** False: only areas in use (for pickers). Default true (the settings page). */
    includeArchived: z.boolean().default(true),
  }),
  async run({ ctx, input, tx }) {
    const rows = await tx
      .select({ ...areaColumns, customerCount: count(customers.id) })
      .from(areas)
      .leftJoin(
        customers,
        and(eq(customers.operatorId, areas.operatorId), eq(customers.areaId, areas.id)),
      )
      .where(input.includeArchived ? undefined : isNull(areas.archivedAt))
      .groupBy(areas.id)
      .orderBy(isNotNull(areas.archivedAt), sql`lower(${areas.name})`, asc(areas.id));
    const view: AreaListView = { areas: rows, ...(await settingsAccess(tx, ctx)) };
    return ok(view);
  },
});

/** Adds an area. Owner only. */
export const createArea = defineService({
  name: "areas.create",
  capability: "business_profile.manage",
  input: z.object({ name: AreaName }),
  async run({ ctx, input, tx, audit, now }) {
    const free = await checkNameFree(tx, input.name);
    if (!free.ok) return err(free.error);
    const [row] = await tx
      .insert(areas)
      .values({
        id: uuidv7(),
        operatorId: ctx.operatorId,
        name: input.name,
        createdAt: now,
        updatedAt: now,
      })
      .returning(areaColumns);
    if (!row) throw new Error("area insert returned no row");
    await audit.record({ entityType: "area", entityId: row.id, after: { name: row.name } });
    const view: AreaView = { ...row, customerCount: 0 };
    return ok(view);
  },
});

/** Locks one area of the tenant (another tenant's id is simply not there: NOT_FOUND). */
async function lockArea(tx: Tx, areaId: string) {
  const [row] = await tx
    .select(areaColumns)
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1)
    .for("update");
  return row;
}

/** Renames an area (also a change of capitals only). Its customers follow. Owner only. */
export const renameArea = defineService({
  name: "areas.rename",
  capability: "business_profile.manage",
  input: z.object({ areaId: z.uuid(), name: AreaName }),
  async run({ input, tx, audit, now }) {
    const before = await lockArea(tx, input.areaId);
    if (!before) return err(notFound());
    if (before.name === input.name) {
      audit.skip("no_change");
      return ok<AreaView>({ ...before, customerCount: await customerCountOf(tx, before.id) });
    }
    const free = await checkNameFree(tx, input.name, before.id);
    if (!free.ok) return err(free.error);
    const [after] = await tx
      .update(areas)
      .set({ name: input.name, updatedAt: now })
      .where(eq(areas.id, before.id))
      .returning(areaColumns);
    if (!after) return err(notFound());
    await audit.record({
      entityType: "area",
      entityId: after.id,
      before: { name: before.name },
      after: { name: after.name },
    });
    return ok<AreaView>({ ...after, customerCount: await customerCountOf(tx, after.id) });
  },
});

const AreaIdInput = z.object({ areaId: z.uuid() });

/**
 * Hides an area from pickers; its customers keep it. Archiving an archived area changes nothing.
 * Owner only.
 */
export const archiveArea = defineService({
  name: "areas.archive",
  capability: "business_profile.manage",
  input: AreaIdInput,
  async run({ input, tx, audit, now }) {
    const before = await lockArea(tx, input.areaId);
    if (!before) return err(notFound());
    const customerCount = await customerCountOf(tx, before.id);
    if (before.archivedAt !== null) {
      audit.skip("no_change");
      return ok<AreaView>({ ...before, customerCount });
    }
    const [after] = await tx
      .update(areas)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(areas.id, before.id))
      .returning(areaColumns);
    if (!after) return err(notFound());
    await audit.record({
      entityType: "area",
      entityId: after.id,
      before: { archived: false },
      after: { archived: true, customer_count: customerCount },
    });
    return ok<AreaView>({ ...after, customerCount });
  },
});

/** Puts an archived area back in use. Restoring an area in use changes nothing. Owner only. */
export const restoreArea = defineService({
  name: "areas.restore",
  capability: "business_profile.manage",
  input: AreaIdInput,
  async run({ input, tx, audit, now }) {
    const before = await lockArea(tx, input.areaId);
    if (!before) return err(notFound());
    const customerCount = await customerCountOf(tx, before.id);
    if (before.archivedAt === null) {
      audit.skip("no_change");
      return ok<AreaView>({ ...before, customerCount });
    }
    const [after] = await tx
      .update(areas)
      .set({ archivedAt: null, updatedAt: now })
      .where(eq(areas.id, before.id))
      .returning(areaColumns);
    if (!after) return err(notFound());
    await audit.record({
      entityType: "area",
      entityId: after.id,
      before: { archived: true },
      after: { archived: false },
    });
    return ok<AreaView>({ ...after, customerCount });
  },
});
