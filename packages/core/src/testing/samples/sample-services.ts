/**
 * Sample services over `areas` that prove the isolation harness (src/testing/harness.test.ts):
 * correct ones that must pass, and broken ones, each with a realistic bug the harness must catch.
 * Test fixtures only (under testing/, so the production discovery ignores them).
 */
import { areas, uuidv7 } from "@cb/db";
import { err, ok } from "@cb/domain";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../../context/service";
import { notFound, serviceError } from "../../errors/errors";
import { defineIsolationCases, type IsolationSeedArgs } from "../isolation";

const areaInput = z.object({ areaId: z.uuid() });

async function seedArea({ tx, tenant }: IsolationSeedArgs) {
  const areaId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId: tenant.operatorId, name: "North" });
  return { areaId };
}

// ── Correct services ────────────────────────────────────────────────────────────────────────

export const sampleGetArea = defineService({
  name: "samples.get_area",
  capability: "dashboard.view",
  input: areaInput,
  async run({ input, tx }) {
    const [row] = await tx
      .select({ id: areas.id, name: areas.name })
      .from(areas)
      .where(eq(areas.id, input.areaId));
    return row ? ok(row) : err(notFound());
  },
});

export const sampleRenameArea = defineService({
  name: "samples.rename_area",
  capability: "business_profile.manage",
  input: z.object({ areaId: z.uuid(), name: z.string().trim().min(1).max(60) }),
  async run({ input, tx, audit }) {
    const [before] = await tx
      .select({ name: areas.name })
      .from(areas)
      .where(eq(areas.id, input.areaId))
      .for("update");
    if (!before) return err(notFound());
    const [after] = await tx
      .update(areas)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(areas.id, input.areaId))
      .returning({ id: areas.id, name: areas.name });
    if (!after) return err(notFound());
    await audit.record({
      entityType: "area",
      entityId: after.id,
      before: { name: before.name },
      after: { name: after.name },
    });
    return ok(after);
  },
});

export const sampleListAreas = defineService({
  name: "samples.list_areas",
  capability: "dashboard.view",
  input: z.object({}),
  async run({ tx }) {
    const rows = await tx
      .select({ id: areas.id, name: areas.name })
      .from(areas)
      .orderBy(asc(areas.name), asc(areas.id));
    return ok(rows);
  },
});

/** Writes first, then fails the lookup: defineService must roll the write back. */
export const sampleWriteThenGetArea = defineService({
  name: "samples.write_then_get_area",
  capability: "business_profile.manage",
  input: areaInput,
  async run({ ctx, input, tx, audit }) {
    const id = uuidv7();
    await tx.insert(areas).values({ id, operatorId: ctx.operatorId, name: `Scratch ${id}` });
    await audit.record({ entityType: "area", entityId: id, after: { created: true } });
    const [row] = await tx.select({ id: areas.id }).from(areas).where(eq(areas.id, input.areaId));
    return row ? ok(row) : err(notFound());
  },
});

export const sampleGetAreaIsolation = defineIsolationCases(sampleGetArea, {
  seed: seedArea,
  cases: [{ name: "read another tenant's area", input: (s) => ({ areaId: s.areaId }) }],
});

export const sampleRenameAreaIsolation = defineIsolationCases(sampleRenameArea, {
  seed: seedArea,
  cases: [
    { name: "rename another tenant's area", input: (s) => ({ areaId: s.areaId, name: "Taken" }) },
  ],
});

export const sampleListAreasIsolation = defineIsolationCases(sampleListAreas, {
  seed: seedArea,
  cases: [{ name: "list shows only own areas", expect: "no_leak", input: () => ({}) }],
});

export const sampleWriteThenGetAreaIsolation = defineIsolationCases(sampleWriteThenGetArea, {
  seed: seedArea,
  cases: [{ name: "failed call leaves no write", input: (s) => ({ areaId: s.areaId }) }],
});

// ── Broken services (each must be caught) ───────────────────────────────────────────────────

/** Bug: answers FORBIDDEN for an id it can't see, which says "this exists somewhere". */
export const brokenForbiddenGetArea = defineService({
  name: "samples.broken_forbidden_get_area",
  capability: "dashboard.view",
  input: areaInput,
  async run({ input, tx }) {
    const [row] = await tx.select({ id: areas.id }).from(areas).where(eq(areas.id, input.areaId));
    return row ? ok(row) : err(serviceError("FORBIDDEN"));
  },
});

/** Bug: "rename or create": a missing id creates a row (in the caller's tenant) and succeeds. */
export const brokenCreateOnMissArea = defineService({
  name: "samples.broken_create_on_miss_area",
  capability: "business_profile.manage",
  input: z.object({ areaId: z.uuid(), name: z.string().min(1) }),
  async run({ ctx, input, tx, audit }) {
    const updated = await tx
      .update(areas)
      .set({ name: input.name })
      .where(eq(areas.id, input.areaId))
      .returning({ id: areas.id });
    const id = updated[0]?.id ?? uuidv7();
    if (updated.length === 0) {
      await tx
        .insert(areas)
        .values({ id, operatorId: ctx.operatorId, name: `${input.name} ${id}` });
    }
    await audit.record({ entityType: "area", entityId: id, after: { name: input.name } });
    return ok({ id });
  },
});

/**
 * Bug: upserts with the caller-supplied id. Another tenant's id hits the global primary key, so
 * the call answers CONFLICT instead of NOT_FOUND: it confirms the id exists elsewhere.
 */
export const brokenUpsertArea = defineService({
  name: "samples.broken_upsert_area",
  capability: "business_profile.manage",
  input: z.object({ areaId: z.uuid(), name: z.string().min(1) }),
  async run({ ctx, input, tx, audit }) {
    const updated = await tx
      .update(areas)
      .set({ name: input.name })
      .where(eq(areas.id, input.areaId))
      .returning({ id: areas.id });
    if (updated.length === 0) {
      await tx
        .insert(areas)
        .values({ id: input.areaId, operatorId: ctx.operatorId, name: `${input.name} new` });
    }
    await audit.record({ entityType: "area", entityId: input.areaId, after: { name: input.name } });
    return ok({ id: input.areaId });
  },
});

/** Bug: a process-wide cache with no tenant in its key (serves one tenant's list to the next). */
let cachedAreas: { id: string; name: string }[] | undefined;
export const brokenCachedListAreas = defineService({
  name: "samples.broken_cached_list_areas",
  capability: "dashboard.view",
  input: z.object({}),
  async run({ tx }) {
    cachedAreas ??= await tx.select({ id: areas.id, name: areas.name }).from(areas);
    return ok(cachedAreas);
  },
});

/** Resets the broken cache between tests. */
export function resetBrokenCache(): void {
  cachedAreas = undefined;
}

export const brokenForbiddenGetAreaIsolation = defineIsolationCases(brokenForbiddenGetArea, {
  seed: seedArea,
  cases: [{ name: "read another tenant's area", input: (s) => ({ areaId: s.areaId }) }],
});

export const brokenCreateOnMissAreaIsolation = defineIsolationCases(brokenCreateOnMissArea, {
  seed: seedArea,
  cases: [
    { name: "rename another tenant's area", input: (s) => ({ areaId: s.areaId, name: "X" }) },
  ],
});

export const brokenUpsertAreaIsolation = defineIsolationCases(brokenUpsertArea, {
  seed: seedArea,
  cases: [
    { name: "rename another tenant's area", input: (s) => ({ areaId: s.areaId, name: "X" }) },
  ],
});

export const brokenCachedListAreasIsolation = defineIsolationCases(brokenCachedListAreas, {
  seed: seedArea,
  cases: [{ name: "list shows only own areas", expect: "no_leak", input: () => ({}) }],
});
