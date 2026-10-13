/**
 * Isolation coverage (T-025 acceptance): **fails when any service in packages/core/src has no
 * tenant isolation cases.** No database needed.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import * as core from "../index";
import { findCoverageGaps, inputTakesIds } from "./coverage";
import {
  CORE_SOURCE_DIR,
  type DiscoveredCaseSet,
  type DiscoveredService,
  discoverIsolationCaseSets,
  discoverServices,
  listModules,
} from "./discovery";
import { defineIsolationCases, exemptFromIsolation, isIsolationCaseSet } from "./isolation";

describe("isolation coverage of packages/core/src", () => {
  it("every service has tenant isolation cases", async () => {
    const services = await discoverServices();
    const sets = await discoverIsolationCaseSets();
    expect(findCoverageGaps(services, sets)).toEqual([]);
  });

  it("every service exported from @cb/core is one the discovery found", async () => {
    const discovered = new Set((await discoverServices()).map((d) => d.service));
    for (const [name, value] of Object.entries(core)) {
      if (core.isService(value)) expect(discovered.has(value), name).toBe(true);
    }
  });

  it("scans source modules but not tests or the testing folder", () => {
    const modules = listModules(CORE_SOURCE_DIR);
    expect(modules).toContain("index.ts");
    expect(modules).toContain("context/service.ts");
    expect(modules.some((m) => m.endsWith(".test.ts"))).toBe(false);
    expect(modules.some((m) => m.startsWith("testing/"))).toBe(false);
  });
});

describe("the coverage rules catch an uncovered service", () => {
  const tree = fileURLToPath(new URL("./samples/coverage-tree", import.meta.url));

  it("reports exactly the service added without cases (fixture tree)", async () => {
    const services = await discoverServices(tree);
    const sets = await discoverIsolationCaseSets(tree);
    expect(services.map((s) => s.service.name).sort()).toEqual([
      "widgets.export",
      "widgets.get",
      "widgets.list",
    ]);
    expect(sets).toHaveLength(2);
    expect(findCoverageGaps(services, sets)).toEqual([
      'Service "widgets.export" (widgets/widgets.ts#exportWidgets) has no tenant isolation cases: add defineIsolationCases(exportWidgets, …) to widgets/widgets.isolation.ts (see @cb/core/testing).',
    ]);
  });
});

describe("coverage rules (unit)", () => {
  const byId = defineService({
    name: "units.by_id",
    capability: "dashboard.view",
    input: z.object({ thingId: z.uuid() }),
    run: async () => ({ ok: false, error: notFound() }) as const,
  });
  const list = defineService({
    name: "units.list",
    capability: "dashboard.view",
    input: z.object({ page: z.number().int().optional() }),
    run: async () => ({ ok: true, value: [] }) as const,
  });
  const svc = (service: core.AnyService, exportName: string): DiscoveredService => ({
    service,
    file: "units/units.ts",
    exportName,
  });
  const caseSet = (set: ReturnType<typeof exemptFromIsolation>): DiscoveredCaseSet => ({
    set,
    file: "units/units.isolation.ts",
    exportName: "cases",
  });
  const seed = async () => ({ thingId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" });

  it("detects whether an input takes ids", () => {
    expect(inputTakesIds(byId)).toBe(true);
    expect(inputTakesIds(list)).toBe(false);
  });

  it("a service that takes ids needs a not_found case", () => {
    const onlyNoLeak = defineIsolationCases(byId, {
      seed,
      cases: [{ name: "x", expect: "no_leak", input: (s) => ({ thingId: s.thingId }) }],
    });
    expect(findCoverageGaps([svc(byId, "byId")], [caseSet(onlyNoLeak)])).toEqual([
      'units/units.isolation.ts#cases: "units.by_id" takes ids but has no "not_found" case (call it with the other tenant\'s ids).',
    ]);
  });

  it("an empty case list is a gap", () => {
    const empty = defineIsolationCases(list, { seed, cases: [] });
    expect(findCoverageGaps([svc(list, "list")], [caseSet(empty)])).toEqual([
      'units/units.isolation.ts#cases has no cases for "units.list".',
    ]);
  });

  it("an exemption needs a real reason", () => {
    expect(
      findCoverageGaps([svc(list, "list")], [caseSet(exemptFromIsolation(list, "n/a"))]),
    ).toEqual(['units/units.isolation.ts#cases exempts "units.list" without a real reason.']);
    expect(
      findCoverageGaps(
        [svc(list, "list")],
        [
          caseSet(
            exemptFromIsolation(list, "Reads only the static plan catalogue; no tenant rows."),
          ),
        ],
      ),
    ).toEqual([]);
  });

  it("cases for a service no module exports are reported", () => {
    const orphan = defineIsolationCases(list, {
      seed,
      cases: [{ name: "x", expect: "no_leak", input: () => ({}) }],
    });
    expect(findCoverageGaps([], [caseSet(orphan)])).toEqual([
      'units/units.isolation.ts#cases registers cases for "units.list", which no core module exports (export the service).',
    ]);
  });

  it("two services with one name are reported", () => {
    const twin = defineService({
      name: "units.list",
      capability: "dashboard.view",
      input: z.object({}),
      run: async () => ({ ok: true, value: 1 }) as const,
    });
    const gaps = findCoverageGaps([svc(list, "list"), svc(twin, "twin")], []);
    expect(gaps[0]).toContain('Two services are named "units.list"');
  });

  it("isIsolationCaseSet recognises case sets only", () => {
    expect(isIsolationCaseSet(exemptFromIsolation(list, "x"))).toBe(true);
    expect(isIsolationCaseSet({ service: list, cases: [] })).toBe(false);
  });
});
