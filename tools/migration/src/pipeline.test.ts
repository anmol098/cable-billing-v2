/**
 * Staging + profiling end to end on Postgres: synthetic fixture → copy into `legacy` → profile →
 * personal-data check. The fixture plants personal data (including inside status columns) that
 * must not reach the report, and anomalies whose counts the report must get right.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEGACY_SCHEMA } from "./config";
import { copyLegacy } from "./copy/copy";
import { generateFixture } from "./fixture/generate";
import { collectForbiddenValues } from "./pii/forbidden";
import { scanForPii } from "./pii/scan";
import { readCatalog } from "./profile/catalog";
import { type ProfileRun, runProfile } from "./profile/run";
import type { ColumnProfile, Profile } from "./profile/types";
import { MemorySource } from "./source/memory";
import * as oracle from "./testing/oracle";
import { createScratchDatabase, pgTestsSkipped, type ScratchDatabase } from "./testing/pg";

const fixture = generateFixture({ scale: "small", seed: 7 });
const NOW = new Date("2026-10-13T04:30:00Z");

function columnOf(profile: Profile, table: string, name: string): ColumnProfile {
  const found = profile.tables.find((t) => t.name === table)?.columns.find((c) => c.name === name);
  if (!found) throw new Error(`${table}.${name} not profiled`);
  return found;
}

describe.skipIf(pgTestsSkipped())("staging and profiling (Postgres)", () => {
  let db: ScratchDatabase;
  let run: ProfileRun;

  beforeAll(async () => {
    db = await createScratchDatabase();
    await copyLegacy(new MemorySource(fixture.tables, "fixture"), db.client, { batchSize: 250 });
    run = await runProfile(db.client, NOW);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("copies every table raw, with exact row counts and zero dates intact", async () => {
    for (const table of fixture.tables) {
      const result = await db.client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${LEGACY_SCHEMA}."${table.name}"`,
      );
      expect(Number(result.rows[0]?.n), table.name).toBe(table.rows.length);
    }
    const zero = await db.client.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${LEGACY_SCHEMA}.vc WHERE start_date = '0000-00-00'`,
    );
    expect(Number(zero.rows[0]?.n)).toBe(oracle.zeroDates(fixture, "vc", "start_date"));
    const receipt = await db.client.query(
      `SELECT "isReceipt" FROM ${LEGACY_SCHEMA}.invoice LIMIT 1`,
    );
    expect(receipt.rows).toHaveLength(1);
  });

  it("closes the legacy schema to PUBLIC", async () => {
    const result = await db.client.query<{ ok: boolean }>(
      "SELECT has_schema_privilege('public', $1, 'USAGE') AS ok",
      [LEGACY_SCHEMA],
    );
    expect(result.rows[0]?.ok).toBe(false);
  });

  it("writes a profile that passes the personal-data check", () => {
    expect(run.findings).toEqual([]);
    expect(run.profile.date).toBe("2026-10-13");
    expect(run.markdown).toContain("# Legacy data profile, 2026-10-13");
  });

  it("leaks none of the fixture's personal data (independent check)", () => {
    const text = run.markdown.toLowerCase();
    const leaked = fixture.personalValues.filter(
      (value) => value.length >= 6 && text.includes(value.toLowerCase()),
    );
    expect(leaked).toEqual([]);
    for (const word of fixture.plantedWords) {
      expect(run.markdown).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
    }
    // No 10-digit phone numbers, no hex password hashes, no e-mail addresses.
    expect(run.markdown).not.toMatch(/[6-9]\d{9}/);
    expect(run.markdown).not.toMatch(/[a-f0-9]{32}/);
    expect(run.markdown).not.toMatch(/[\w.]+@[\w-]+\.[a-z]{2,}/i);
  });

  it("holds back status values that are rare or personal, and shows real codes", () => {
    const customer = columnOf(run.profile, "costumer", "status").values;
    const shownCustomer = customer?.shown.map((v) => v.value) ?? [];
    expect(shownCustomer).toEqual(expect.arrayContaining(["active", "inactive", "Active"]));
    expect(shownCustomer).toHaveLength(3);
    const counts = oracle.valueCounts(fixture, "costumer", "status");
    // "left" (2 rows), a phone number and a full name are held back.
    expect(customer?.suppressedValues).toBe(counts.size - 3);

    const vc = columnOf(run.profile, "vc", "status").values;
    expect(vc?.shown.map((v) => v.value).sort()).toEqual(["A", "D", "S"]);
    expect(vc?.suppressedValues).toBe(1); // the planted lineman first name, used by 5+ rows

    const receipt = columnOf(run.profile, "invoice", "isReceipt").values;
    expect(receipt?.shown.map((v) => v.value).sort()).toEqual(["0", "1"]);
    const mode = columnOf(run.profile, "invoice", "pay_mode").values;
    expect(mode?.shown.map((v) => v.value).sort()).toEqual(["CASH", "cash", "upi"]);
  });

  it("never lists values of sensitive columns", () => {
    for (const table of run.profile.tables) {
      for (const column of table.columns) {
        if (column.class === "sensitive") {
          expect(column.values, `${table.name}.${column.name}`).toBeNull();
          expect(column.dates?.min ?? null).toBeNull();
        }
      }
    }
    expect(columnOf(run.profile, "lineman", "password").class).toBe("sensitive");
    expect(columnOf(run.profile, "invoice", "remark").class).toBe("sensitive");
  });

  it("counts rows, zero dates and invalid dates", () => {
    for (const table of fixture.tables) {
      const profiled = run.profile.tables.find((t) => t.name === table.name);
      expect(profiled?.rows, table.name).toBe(table.rows.length);
      expect(profiled?.documented).toBe(true);
    }
    for (const [table, name] of [
      ["costumer", "created_at"],
      ["vc", "start_date"],
      ["recharge", "to_date"],
      ["invoice", "created_at"],
      ["ledger", "updated_at"],
    ] as const) {
      expect(columnOf(run.profile, table, name).dates?.zero, `${table}.${name}`).toBe(
        oracle.zeroDates(fixture, table, name),
      );
    }
    const invalid = oracle
      .column(fixture, "costumer", "created_at")
      .filter((v) => String(v).startsWith("2019-00-")).length;
    expect(invalid).toBeGreaterThan(0);
    expect(columnOf(run.profile, "costumer", "created_at").dates?.invalid).toBe(invalid);
  });

  it("counts null, zero and orphan references", () => {
    const check = (name: string, table: string, col: string, parent: string, key: string) => {
      const result = run.profile.relations.find((r) => r.name === name);
      expect(result?.status).toMatchObject({ checked: true, column: col, parentKey: key });
      const expected = oracle.references(fixture, table, col, parent, key);
      expect({ nulls: result?.nulls, zero: result?.zero, orphans: result?.orphans }, name).toEqual(
        expected,
      );
      return expected;
    };
    expect(check("vc → costumer", "vc", "customer", "costumer", "id").orphans).toBeGreaterThan(0);
    expect(
      check("invoice → costumer", "invoice", "customer", "costumer", "id").nulls,
    ).toBeGreaterThan(0);
    check("invoice → lineman", "invoice", "lineman", "lineman", "id");
    check("ledger → vc", "ledger", "vc", "vc", "id");
    check("recharge → vc", "recharge", "vc", "vc", "id");
    check("costumer → operator", "costumer", "op_id", "operator", "op_id");
  });

  it("counts duplicates, per operator where it matters", () => {
    const find = (name: string) => run.profile.duplicates.find((d) => d.name === name);
    const codes = oracle.duplicates(fixture, "costumer", "code", "op_id");
    expect(codes.groups).toBeGreaterThan(0);
    expect(find("customer code per operator")).toMatchObject(codes);
    expect(find("VC number per operator")).toMatchObject(
      oracle.duplicates(fixture, "vc", "vc_no", "op_id"),
    );
    expect(find("lineman login (global)")).toMatchObject({ groups: 1, rows: 2 });
    expect(find("operator display name (global)")).toMatchObject({ groups: 1, rows: 2 });
  });

  it("counts float anomalies", () => {
    for (const [table, name] of [
      ["vc", "balance"],
      ["ledger", "balance"],
      ["ledger", "last_paid"],
    ] as const) {
      const numbers = columnOf(run.profile, table, name).numbers;
      const expected = oracle.floats(fixture, table, name);
      expect(expected.subPaisa).toBeGreaterThan(0);
      expect(
        {
          negative: numbers?.negative,
          fractional: numbers?.fractional,
          subPaisa: numbers?.subPaisa,
        },
        `${table}.${name}`,
      ).toEqual(expected);
    }
    expect(columnOf(run.profile, "invoice", "amount").numbers?.wholeHundreds).toBeGreaterThan(0);
  });

  it("breaks rows down per operator id", () => {
    const breakdown = run.profile.operators;
    expect(breakdown?.operatorIds).toEqual(["1", "2", "3"]);
    const customers = breakdown?.tables.find((t) => t.table === "costumer");
    expect(customers?.nullOperator).toBe(
      oracle.column(fixture, "costumer", "op_id").filter((v) => v === null).length,
    );
    for (const t of breakdown?.tables ?? []) expect(t.groupSum, t.table).toBe(t.total);
  });

  it("catches personal data planted into a finished report", async () => {
    const forbidden = await collectForbiddenValues(db.client, await readCatalog(db.client));
    const name = String(oracle.column(fixture, "costumer", "name")[5]);
    const password = String(oracle.column(fixture, "lineman", "password")[1]);
    const address = String(oracle.column(fixture, "costumer", "address")[9]);
    const mobile = String(oracle.column(fixture, "lineman", "mobile")[0]);
    for (const leak of [name, password, address, `${mobile.slice(0, 5)} ${mobile.slice(5)}`]) {
      const findings = scanForPii(`${run.markdown}\n| leaked | ${leak} |\n`, forbidden);
      expect(findings.length, "a leak must be found").toBeGreaterThan(0);
    }
  });

  it("re-copies idempotently and removes tables that left the source", async () => {
    const withoutRecharge = fixture.tables.filter((t) => t.name !== "recharge");
    const result = await copyLegacy(new MemorySource(withoutRecharge, "fixture-2"), db.client);
    expect(result.droppedStale).toEqual(["recharge"]);
    const catalog = await readCatalog(db.client);
    expect(catalog.tables.map((t) => t.name)).not.toContain("recharge");
    expect(catalog.lastRun?.sourceLabel).toBe("fixture-2");
    const again = await runProfile(db.client, NOW);
    expect(again.findings).toEqual([]);
    expect(again.profile.missingDocumentedTables).toEqual(["recharge"]);
    expect(again.profile.relations.find((r) => r.name === "recharge → vc")?.status).toEqual({
      checked: false,
      reason: "no table recharge",
    });
  });
});

describe.skipIf(pgTestsSkipped())("legacy scale (PRD App. A counts)", () => {
  it("copies 180k rows and profiles them without a personal-data finding", async () => {
    const big = generateFixture({ scale: "legacy", seed: 7 });
    const db = await createScratchDatabase();
    try {
      await copyLegacy(new MemorySource(big.tables, "fixture-legacy"), db.client);
      const result = await runProfile(db.client, NOW);
      // Many more names and addresses than the small fixture: none collides with the report's words.
      expect(result.findings).toEqual([]);
      for (const table of result.profile.tables) {
        if (table.baseline !== null) expect(table.rows, table.name).toBe(table.baseline);
      }
      const text = result.markdown.toLowerCase();
      expect(
        big.personalValues.filter((v) => v.length >= 6 && text.includes(v.toLowerCase())),
      ).toEqual([]);
    } finally {
      await db.drop();
    }
  }, 180_000);
});
