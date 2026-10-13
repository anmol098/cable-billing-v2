/**
 * Tenant isolation cases for the area services (T-030, PLAN §9.1, §16). Renaming, archiving or
 * restoring another tenant's area answers NOT_FOUND and changes nothing; the list shows only the
 * caller's own areas; adding an area writes only to the caller's tenant (and a name used by
 * another tenant is free: the unique name is per operator).
 */
import { areas, uuidv7 } from "@cb/db";
import type { IsolationSeedArgs } from "../testing/isolation";
import { defineIsolationCases } from "../testing/isolation";
import { archiveArea, createArea, listAreas, renameArea, restoreArea } from "./areas";

async function seedArea({ tx, tenant }: IsolationSeedArgs) {
  const areaId = uuidv7();
  await tx.insert(areas).values({ id: areaId, operatorId: tenant.operatorId, name: "North" });
  return { areaId };
}

async function seedArchivedArea({ tx, tenant }: IsolationSeedArgs) {
  const areaId = uuidv7();
  await tx.insert(areas).values({
    id: areaId,
    operatorId: tenant.operatorId,
    name: "Old market",
    archivedAt: new Date("2026-10-01T00:00:00Z"),
  });
  return { areaId };
}

export const listAreasIsolation = defineIsolationCases(listAreas, {
  seed: seedArea,
  cases: [
    { name: "list shows only own areas", expect: "no_leak", input: () => ({}) },
    {
      name: "picker list shows only own areas",
      expect: "no_leak",
      input: () => ({ includeArchived: false }),
    },
  ],
});

export const createAreaIsolation = defineIsolationCases(createArea, {
  // Nothing to find: the case checks the write lands only in the caller's tenant.
  seed: async () => ({}),
  cases: [
    {
      name: "add an area only to the own tenant (same name as the other tenant's)",
      expect: "no_leak",
      input: () => ({ name: "Station road" }),
    },
  ],
});

export const renameAreaIsolation = defineIsolationCases(renameArea, {
  seed: seedArea,
  cases: [
    {
      name: "rename another tenant's area",
      input: (s) => ({ areaId: s.areaId, name: "Taken over" }),
    },
  ],
});

export const archiveAreaIsolation = defineIsolationCases(archiveArea, {
  seed: seedArea,
  cases: [{ name: "hide another tenant's area", input: (s) => ({ areaId: s.areaId }) }],
});

export const restoreAreaIsolation = defineIsolationCases(restoreArea, {
  seed: seedArchivedArea,
  cases: [{ name: "show another tenant's hidden area", input: (s) => ({ areaId: s.areaId }) }],
});
