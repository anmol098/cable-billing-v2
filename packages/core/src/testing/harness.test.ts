/**
 * Proves the tenant isolation harness on sample services: correct services pass, and each broken
 * one (a realistic tenancy bug) is caught with the right violation.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeEach, expect, it } from "vitest";
import { databaseFingerprint } from "./fingerprint";
import { checkIsolationCase, collectUuids, type IsolationCaseSet } from "./isolation";
import {
  brokenCachedListAreasIsolation,
  brokenCreateOnMissAreaIsolation,
  brokenForbiddenGetAreaIsolation,
  brokenUpsertAreaIsolation,
  resetBrokenCache,
  sampleGetAreaIsolation,
  sampleListAreasIsolation,
  sampleRenameAreaIsolation,
  sampleWriteThenGetAreaIsolation,
} from "./samples/sample-services";

function only(set: IsolationCaseSet) {
  const [first] = set.cases;
  if (!first) throw new Error("sample set has no case");
  return first;
}

it("collectUuids finds ids anywhere in a value, lower-cased", () => {
  const ids = collectUuids({
    a: "0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B",
    b: [{ c: "x 0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c y" }],
    n: 12,
  });
  expect([...ids].sort()).toEqual([
    "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
  ]);
});

describeDb("tenant isolation harness (sample services)", () => {
  const t = useTestDatabase();
  beforeEach(() => resetBrokenCache());

  it.each([
    ["get by id", sampleGetAreaIsolation],
    ["rename (audited write)", sampleRenameAreaIsolation],
    ["list (no_leak)", sampleListAreasIsolation],
    ["write then NOT_FOUND (rolled back)", sampleWriteThenGetAreaIsolation],
  ])("a correct service passes: %s", async (_label, set) => {
    expect(await checkIsolationCase(t.current, set, only(set))).toEqual([]);
  });

  it("catches FORBIDDEN instead of NOT_FOUND (existence leak)", async () => {
    const set = brokenForbiddenGetAreaIsolation;
    expect(await checkIsolationCase(t.current, set, only(set))).toEqual([
      "[owner] expected NOT_FOUND, got FORBIDDEN",
      "[staff] expected NOT_FOUND, got FORBIDDEN",
    ]);
  });

  it("catches a service that writes and succeeds for another tenant's id", async () => {
    const set = brokenCreateOnMissAreaIsolation;
    const violations = await checkIsolationCase(t.current, set, only(set));
    expect(violations).toContain("[owner] expected NOT_FOUND for the other tenant's ids, got ok");
    expect(violations).toContain("[owner] the database changed: areas, audit_events");
  });

  it("catches CONFLICT from a caller-chosen id (confirms the id exists elsewhere)", async () => {
    const set = brokenUpsertAreaIsolation;
    expect(await checkIsolationCase(t.current, set, only(set))).toEqual([
      "[owner] expected NOT_FOUND, got CONFLICT",
    ]);
  });

  it("catches a cache shared across tenants (no_leak)", async () => {
    const set = brokenCachedListAreasIsolation;
    const violations = await checkIsolationCase(t.current, set, only(set));
    expect(violations).toContain("[owner] output contains the other tenant's ids");
    expect(violations).toContain(
      "[owner] control failed: the tenant's own seeded rows are not in the output",
    );
  });

  it("reports a case that names a role without the capability", async () => {
    const set = sampleRenameAreaIsolation;
    const violations = await checkIsolationCase(t.current, set, {
      ...only(set),
      roles: ["staff"],
    });
    expect(violations).toEqual([
      "[staff] role is not allowed business_profile.manage; fix the case's roles",
    ]);
  });

  it("reports a failing control (the case doesn't exercise the lookup)", async () => {
    const set = sampleGetAreaIsolation;
    // Wrong input builder: ignores the seed, so even the tenant's own call is NOT_FOUND.
    const violations = await checkIsolationCase(t.current, set, {
      name: "bad case",
      input: () => ({ areaId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }),
    });
    expect(violations).toEqual([
      "control failed: with the tenant's own ids the call gave NOT_FOUND, not ok",
    ]);
  });

  it("the fingerprint sees a change in any table", async () => {
    const before = await databaseFingerprint(t.current);
    await t.current.admin.query(
      "INSERT INTO operators (id, name) VALUES (gen_random_uuid(), 'Fingerprint probe')",
    );
    const after = await databaseFingerprint(t.current);
    expect(Object.keys(before)).toContain("audit_events");
    expect(before.operators).not.toEqual(after.operators);
    expect(before.areas).toEqual(after.areas);
  });
});
