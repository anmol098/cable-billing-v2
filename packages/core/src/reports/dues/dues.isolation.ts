/**
 * Tenant isolation cases for the dues report (T-080, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts. The list has no ids in its input (`no_leak`); the area filter
 * takes one (another tenant's area → NOT_FOUND).
 */
import { defineIsolationCases } from "../../testing/isolation";
import { duesReport } from "./queries";
import { seedOwingCustomer } from "./test-seed";

export const duesReportIsolation = defineIsolationCases(duesReport, {
  seed: seedOwingCustomer,
  cases: [
    {
      name: "the dues report lists only the tenant's own customers",
      expect: "no_leak",
      input: () => ({}),
    },
    {
      name: "the dues report filtered by another tenant's area",
      input: (seed) => ({ areaId: seed.areaId }),
    },
  ],
});
