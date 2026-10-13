/**
 * The real path: synthetic dump → MariaDB → MariaDbSource → Postgres `legacy` → profile. Its
 * profile must equal the one built from the same fixture held in memory, which proves the MariaDB
 * reader returns raw values (zero dates, floats, flags) exactly as the in-memory tests assume.
 *
 * Needs LEGACY_TEST_MARIADB_URL (CI has no MariaDB: the suite is skipped there, loudly).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyLegacy } from "../copy/copy";
import { toMysqlDump } from "../fixture/dump";
import { generateFixture } from "../fixture/generate";
import { runProfile } from "../profile/run";
import type { Profile } from "../profile/types";
import { createScratchMariaDb, mariadbTestUrl, type ScratchMariaDb } from "../testing/mariadb";
import { createScratchDatabase, pgTestsSkipped, type ScratchDatabase } from "../testing/pg";
import { MariaDbSource } from "./mariadb";
import { MemorySource } from "./memory";

const serverUrl = mariadbTestUrl();
if (!serverUrl) {
  console.warn(
    "[@cb/migration] MariaDB suite skipped: set LEGACY_TEST_MARIADB_URL " +
      "(e.g. mysql://root:legacy-local-only@127.0.0.1:3307/) to run it.",
  );
}

const fixture = generateFixture({ scale: "small", seed: 11 });
const NOW = new Date("2026-10-13T04:30:00Z");
const comparable = (profile: Profile) => ({ ...profile, copyRun: null, generatedAt: "" });

describe.skipIf(!serverUrl || pgTestsSkipped())("MariaDB source (real restore path)", () => {
  let maria: ScratchMariaDb;
  let viaMaria: ScratchDatabase;
  let viaMemory: ScratchDatabase;

  beforeAll(async () => {
    maria = await createScratchMariaDb(serverUrl ?? "");
    await maria.load([...toMysqlDump(fixture.tables)].join(""));
    viaMaria = await createScratchDatabase();
    viaMemory = await createScratchDatabase();
  });

  afterAll(async () => {
    await maria?.drop();
    await viaMaria?.drop();
    await viaMemory?.drop();
  });

  it("describes the tables the way the fixture declares them", async () => {
    const source = await MariaDbSource.connect(maria.url);
    try {
      const tables = await source.listTables();
      const expected = [...fixture.tables]
        .map(({ name, columns }) => ({ name, columns }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(tables).toEqual(expected);
      const vc = tables.find((t) => t.name === "vc");
      expect(await source.countRows(vc ?? { name: "vc", columns: [] })).toBe(
        fixture.tables.find((t) => t.name === "vc")?.rows.length,
      );
    } finally {
      await source.close();
    }
  });

  it("reads raw values: zero dates, floats and flags survive", async () => {
    const source = await MariaDbSource.connect(maria.url);
    try {
      const table = (await source.listTables()).find((t) => t.name === "vc");
      if (!table) throw new Error("vc missing");
      const rows: unknown[][] = [];
      for await (const batch of source.readRows(table, 50)) rows.push(...batch);
      const expected = fixture.tables.find((t) => t.name === "vc")?.rows ?? [];
      expect(rows).toEqual(expected);
    } finally {
      await source.close();
    }
  });

  it("produces exactly the same profile as the in-memory fixture", async () => {
    const source = await MariaDbSource.connect(maria.url);
    try {
      await copyLegacy(source, viaMaria.client, { batchSize: 300 });
    } finally {
      await source.close();
    }
    await copyLegacy(new MemorySource(fixture.tables), viaMemory.client, { batchSize: 300 });
    const fromMaria = await runProfile(viaMaria.client, NOW);
    const fromMemory = await runProfile(viaMemory.client, NOW);
    expect(fromMaria.findings).toEqual([]);
    expect(comparable(fromMaria.profile)).toEqual(comparable(fromMemory.profile));
  });
});
