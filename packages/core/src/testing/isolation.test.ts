/**
 * THE tenant isolation suite (PLAN §16): every case of every `*.isolation.ts` under
 * packages/core/src, against a real database. Feature tasks don't edit this file; they add an
 * isolation file next to their service.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it } from "vitest";
import { discoverIsolationCaseSets } from "./discovery";
import { checkIsolationCase } from "./isolation";

const discovered = await discoverIsolationCaseSets();

describeDb("tenant isolation suite", () => {
  const t = useTestDatabase();

  it("discovers the isolation case files", () => {
    // Every exported service is covered (coverage.test.ts); this just shows what runs here.
    expect(discovered.every((d) => d.file.endsWith(".isolation.ts"))).toBe(true);
  });

  for (const { set, file } of discovered) {
    for (const testCase of set.cases) {
      it(`${set.service.name}: ${testCase.name} (${file})`, async () => {
        expect(await checkIsolationCase(t.current, set, testCase)).toEqual([]);
      }, 120_000);
    }
  }
});
