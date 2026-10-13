/**
 * The generator without a database: determinism, the shapes the scope asks for (two operators with
 * the same name, reused VCs, Hindi and English names, fake phones) and the business rules the
 * rows must follow before they reach the database.
 */
import { type BusinessDate, businessDate, compareBusinessDates } from "@cb/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { datasetCounts, datasetHash, type SeedDataset } from "./dataset";
import type { GeneratedOperator } from "./generate";
import { SCALE_CONFIGS } from "./scales";
import { generateSeed, planOperators, SEED_DEV_PASSWORD_HASH } from "./seed";

const AS_OF = businessDate("2026-10-13");
const PERIODS = 12;

let operators: readonly GeneratedOperator[];
let hash: string;
const all = <K extends keyof SeedDataset>(key: K): SeedDataset[K] => {
  const rows: unknown[] = [];
  for (const op of operators) rows.push(...op.data[key]);
  return rows as SeedDataset[K];
};

beforeAll(() => {
  ({ operators, hash } = generateSeed({ scale: "small", seed: 7, asOf: AS_OF }));
});

describe("determinism", () => {
  it("same seed → same rows (hash and counts); another seed or date → different rows", () => {
    const again = generateSeed({ scale: "small", seed: 7, asOf: AS_OF });
    expect(again.hash).toBe(hash);
    expect(again.operators.map((op) => datasetCounts(op.data))).toEqual(
      operators.map((op) => datasetCounts(op.data)),
    );
    expect(generateSeed({ scale: "small", seed: 8, asOf: AS_OF }).hash).not.toBe(hash);
    expect(
      generateSeed({ scale: "small", seed: 7, asOf: businessDate("2026-10-14") }).hash,
    ).not.toBe(hash);
  });

  it("hashes depend on the data, not on object identity", () => {
    const op = operators[0] as GeneratedOperator;
    const copy = structuredClone(op.data);
    expect(datasetHash(copy)).toBe(datasetHash(op.data));
    (copy.payments[0] as { amountPaise: number }).amountPaise += 100;
    expect(datasetHash(copy)).not.toBe(datasetHash(op.data));
  });
});

describe("scale plans", () => {
  it("splits customers and linemen exactly, and two operators share a name", () => {
    for (const scale of ["small", "legacy", "10x"] as const) {
      const config = SCALE_CONFIGS[scale];
      const plan = planOperators(config, "1");
      expect(plan).toHaveLength(config.operators);
      expect(plan.reduce((n, op) => n + op.customers, 0)).toBe(config.customers);
      expect(plan.reduce((n, op) => n + op.linemen, 0)).toBe(config.linemen);
      expect(plan[0]?.name).toBe(plan[1]?.name);
    }
  });
});

describe("the small dataset", () => {
  it("has the planned operators, customers and 12 months of runs", () => {
    expect(operators).toHaveLength(3);
    expect(operators[0]?.name).toBe(operators[1]?.name);
    expect(operators[0]?.operatorId).not.toBe(operators[1]?.operatorId);
    expect(all("customers")).toHaveLength(SCALE_CONFIGS.small.customers);
    const runs = all("billingRuns");
    expect(runs).toHaveLength(3 * PERIODS);
    expect(new Set(runs.map((r) => r.period)).size).toBe(PERIODS);
    expect(all("invoices").length).toBeGreaterThan(1_000);
    expect(all("payments").length).toBeGreaterThan(500);
  });

  it("uses Hindi and English names and only fake 555 phone numbers", () => {
    const names = all("customers").map((c) => c.name);
    expect(names.some((n) => /[ऀ-ॿ]/.test(n))).toBe(true);
    expect(names.some((n) => /^[A-Za-z ]+$/.test(n))).toBe(true);
    const phones = [
      ...all("customers").flatMap((c) => [c.phone, c.altPhone]),
      ...all("users").map((u) => u.phone),
      ...all("operators").map((o) => o.phone),
    ].filter((p): p is string => typeof p === "string");
    expect(phones.length).toBeGreaterThan(100);
    for (const phone of phones) expect(phone).toMatch(/^555\d{7}$/);
    for (const user of all("users")) {
      expect(user.email ?? "@seed.cable.test").toMatch(/@seed\.cable\.test$/);
    }
  });

  it("reuses VCs sequentially: a later assignment starts after the earlier one ended", () => {
    const byAsset = new Map<string, SeedDataset["vcAssignments"]>();
    for (const a of all("vcAssignments")) {
      byAsset.set(a.vcAssetId, [...(byAsset.get(a.vcAssetId) ?? []), a]);
    }
    const reused = [...byAsset.values()].filter((list) => list.length > 1);
    expect(reused.length).toBeGreaterThan(0);
    for (const list of reused) {
      const sorted = [...list].sort((a, b) =>
        compareBusinessDates(a.startDate as BusinessDate, b.startDate as BusinessDate),
      );
      for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1] as (typeof sorted)[number];
        const next = sorted[i] as (typeof sorted)[number];
        expect(prev.endDate).not.toBeNull();
        expect(
          compareBusinessDates(prev.endDate as BusinessDate, next.startDate as BusinessDate),
        ).toBe(-1);
        expect(prev.customerId).not.toBe(next.customerId);
      }
    }
  });

  it("follows the billing rules: one regular bill per customer and month, totals add up", () => {
    const seen = new Set<string>();
    for (const inv of all("invoices")) {
      expect(inv.totalDuePaise).toBe(
        (inv.openingBalancePaise as number) + (inv.chargesPaise as number),
      );
      if (inv.kind !== "regular") continue;
      const key = `${inv.customerId}|${inv.period}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    const linesByInvoice = new Map<string, number>();
    for (const line of all("invoiceLines")) {
      linesByInvoice.set(
        line.invoiceId,
        (linesByInvoice.get(line.invoiceId) ?? 0) + line.amountPaise,
      );
    }
    for (const inv of all("invoices")) {
      if (inv.kind === "regular")
        expect(linesByInvoice.get(inv.id as string)).toBe(inv.chargesPaise);
    }
    // Invoice numbers are gap-free per operator.
    for (const op of operators) {
      const seqs = op.data.invoices
        .map((i) => Number(i.invoiceNumber.split("-").at(-1)))
        .sort((a, b) => a - b);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    }
  });

  it("covers the money paths: credit, adjustments of every source, reversals, review flags", () => {
    const sources = new Set(all("adjustments").map((a) => `${a.source}:${a.direction}`));
    expect(sources).toContain("mid_month_start:debit");
    expect(sources).toContain("manual:debit");
    expect(sources).toContain("manual:credit");
    expect([...sources].some((s) => s.startsWith("plan_change:"))).toBe(true);
    const kinds = new Set(all("allocations").map((a) => a.kind));
    expect(kinds).toEqual(new Set(["posting", "credit_application"]));
    expect(all("paymentReversals").length).toBeGreaterThan(0);
    expect(all("reversalAllocations").every((a) => (a.amountPaise as number) < 0)).toBe(true);
    expect(all("invoices").some((i) => i.kind === "opening_balance")).toBe(true);
    expect(all("payments").some((p) => p.reviewStatus === "needs_review")).toBe(true);
    expect(all("customerBalances").some((b) => (b.creditPaise as number) > 0)).toBe(true);
    expect(all("customerBalances").some((b) => (b.balancePaise as number) > 0)).toBe(true);
  });

  it("never dates anything after asOf, and gives every user the dev password", () => {
    const end = new Date("2026-10-13T18:30:00Z").getTime(); // end of 13 Oct in IST
    for (const p of all("payments")) expect((p.postedAt as Date).getTime()).toBeLessThan(end);
    for (const e of all("ledgerEntries")) expect((e.at as Date).getTime()).toBeLessThan(end);
    for (const a of all("vcAssignments")) {
      expect(compareBusinessDates(a.startDate as BusinessDate, AS_OF)).toBeLessThanOrEqual(0);
    }
    expect(all("accounts")).toHaveLength(all("users").length);
    expect(all("accounts").every((a) => a.password === SEED_DEV_PASSWORD_HASH)).toBe(true);
    const none = generateSeed({
      scale: "small",
      seed: 7,
      asOf: AS_OF,
      months: 1,
      passwordHash: null,
    });
    expect(none.operators.flatMap((op) => op.data.accounts)).toHaveLength(0);
  });
});
