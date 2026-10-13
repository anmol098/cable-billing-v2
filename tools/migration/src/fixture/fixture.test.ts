import { describe, expect, it } from "vitest";
import { BASELINE_COUNTS, DOCUMENTED_TABLES } from "../config";
import { mysqlLiteral, toMysqlDump } from "./dump";
import { generateFixture } from "./generate";

describe("generateFixture", () => {
  it("uses exactly the documented legacy table names", () => {
    const names = generateFixture().tables.map((t) => t.name);
    expect([...names].sort()).toEqual([...DOCUMENTED_TABLES].sort());
  });

  it("is deterministic for a seed", () => {
    const a = generateFixture({ seed: 3 });
    const b = generateFixture({ seed: 3 });
    const c = generateFixture({ seed: 4 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("matches the PRD Appendix A baseline at legacy scale", () => {
    const fixture = generateFixture({ scale: "legacy" });
    for (const [table, count] of Object.entries(BASELINE_COUNTS)) {
      expect(fixture.tables.find((t) => t.name === table)?.rows.length, table).toBe(count);
    }
  }, 60_000);

  it("plants personal data, including inside status columns", () => {
    const fixture = generateFixture();
    expect(fixture.personalValues.length).toBeGreaterThan(300);
    const customer = fixture.tables.find((t) => t.name === "costumer");
    const status = customer?.columns.findIndex((c) => c.name === "status") ?? -1;
    const planted = customer?.rows.map((r) => r[status]).filter((v) => /\d{10}|\s/.test(String(v)));
    expect(planted?.length).toBe(2); // a phone number and a full name
    const vc = fixture.tables.find((t) => t.name === "vc");
    const vcStatus = vc?.columns.findIndex((c) => c.name === "status") ?? -1;
    const word = fixture.plantedWords[0];
    expect(vc?.rows.filter((r) => r[vcStatus] === word).length).toBeGreaterThanOrEqual(5);
  });

  it("keeps every row the same width as its columns", () => {
    for (const table of generateFixture().tables) {
      for (const row of table.rows) expect(row).toHaveLength(table.columns.length);
    }
  });
});

describe("toMysqlDump", () => {
  it("escapes values like mysqldump", () => {
    expect(mysqlLiteral(null)).toBe("NULL");
    expect(mysqlLiteral(-0)).toBe("0");
    expect(mysqlLiteral(249.99)).toBe("249.99");
    expect(mysqlLiteral("it's a \\ test\n")).toBe("'it\\'s a \\\\ test\\n'");
    expect(mysqlLiteral(Buffer.from([0xab]))).toBe("0xab");
  });

  it("writes CREATE TABLE and INSERT statements for every table", () => {
    const fixture = generateFixture();
    const sql = [...toMysqlDump(fixture.tables)].join("");
    for (const table of fixture.tables) {
      expect(sql).toContain(`CREATE TABLE \`${table.name}\``);
    }
    expect(sql).toContain("`isReceipt` tinyint(1) NOT NULL");
    expect(sql).toContain("'0000-00-00'");
    expect(sql).toMatch(/^-- Synthetic legacy fixture: FAKE data/);
  });
});
