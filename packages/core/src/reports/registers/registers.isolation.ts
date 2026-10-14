/**
 * Tenant isolation cases for the register reports (T-080, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts.
 */
import { defineIsolationCases } from "../../testing/isolation";
import { seedOwingCustomer, thisPeriod } from "../dues/test-seed";
import { billRegisterReport } from "./bills";

export const billRegisterReportIsolation = defineIsolationCases(billRegisterReport, {
  seed: seedOwingCustomer,
  cases: [
    {
      name: "the bill register report lists only the tenant's own bills",
      expect: "no_leak",
      input: () => ({ from: thisPeriod(), to: thisPeriod() }),
    },
    {
      name: "the bill register report filtered by another tenant's area",
      input: (seed) => ({ from: thisPeriod(), to: thisPeriod(), areaId: seed.areaId }),
    },
  ],
});
