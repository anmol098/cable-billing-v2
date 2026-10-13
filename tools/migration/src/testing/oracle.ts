/**
 * Expected profile numbers computed straight from the fixture rows, independently of the SQL the
 * profiler runs. Tests compare the two.
 */
import type { Fixture } from "../fixture/generate";
import type { LegacyValue } from "../source/types";

export function column(fixture: Fixture, table: string, name: string): LegacyValue[] {
  const t = fixture.tables.find((x) => x.name === table);
  const index = t?.columns.findIndex((c) => c.name === name) ?? -1;
  if (!t || index < 0) throw new Error(`no ${table}.${name} in the fixture`);
  return t.rows.map((row) => row[index] ?? null);
}

export function rows(fixture: Fixture, table: string): number {
  return fixture.tables.find((t) => t.name === table)?.rows.length ?? 0;
}

export function zeroDates(fixture: Fixture, table: string, name: string): number {
  return column(fixture, table, name).filter((v) => String(v).startsWith("0000-00-00")).length;
}

export function references(
  fixture: Fixture,
  table: string,
  name: string,
  parent: string,
  key: string,
): { nulls: number; zero: number; orphans: number } {
  const keys = new Set(column(fixture, parent, key).map(String));
  const values = column(fixture, table, name);
  return {
    nulls: values.filter((v) => v === null).length,
    zero: values.filter((v) => v === 0 || v === "0" || v === "").length,
    orphans: values.filter((v) => v !== null && v !== 0 && v !== "" && !keys.has(String(v))).length,
  };
}

export function duplicates(
  fixture: Fixture,
  table: string,
  name: string,
  operator: string | null,
): { groups: number; rows: number } {
  const values = column(fixture, table, name);
  const ops = operator ? column(fixture, table, operator) : values.map(() => "");
  const counts = new Map<string, number>();
  values.forEach((v, i) => {
    if (v === null || String(v).trim() === "") return;
    const k = `${ops[i] ?? "null"}|${String(v).trim().toLowerCase()}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  const dup = [...counts.values()].filter((c) => c > 1);
  return { groups: dup.length, rows: dup.reduce((a, b) => a + b, 0) };
}

export function floats(
  fixture: Fixture,
  table: string,
  name: string,
): { negative: number; fractional: number; subPaisa: number } {
  const values = column(fixture, table, name).filter((v): v is number => typeof v === "number");
  return {
    negative: values.filter((v) => v < 0).length,
    fractional: values.filter((v) => !Number.isInteger(v)).length,
    subPaisa: values.filter((v) => Number(v.toFixed(2)) !== v).length,
  };
}

export function valueCounts(fixture: Fixture, table: string, name: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of column(fixture, table, name)) {
    if (v === null) continue;
    counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  }
  return counts;
}
