/**
 * The billing run racing the connection hooks (T-044 / T-045: "the run and the D-18 mid-month hook
 * must not both charge"). Real parallel transactions on a dedicated pool; no sleeps. Whatever
 * order the customer's balance lock gives them, each connection's October rent ends up charged
 * exactly once at the right amount, and the books stay consistent.
 */
import { createDb, type DbClient } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { period, rentalChargedSoFar } from "@cb/domain";
import { afterAll, beforeAll, expect, it } from "vitest";
import { addConnection, changeConnectionPlan } from "../connections/services";
import { rentalRecordsOf } from "./store";
import {
  changedIssuedRows,
  connect,
  issuedSnapshot,
  ist,
  ledgerProblems,
  newCustomer,
  runBilling,
  setPolicy,
  setupTenant,
} from "./test-support";

const CUSTOMERS = 6;
const SEP_1 = ist("2026-09-01", "08:30");
const OCT_1 = ist("2026-10-01", "09:00");
const OCT = period("2026-10-01");

describeDb("adjustments: the billing run racing plan changes and starts", () => {
  const t = useTestDatabase();
  let db: DbClient;

  beforeAll(() => {
    db = createDb({
      connectionString: t.current.url,
      driver: "pg",
      max: CUSTOMERS * 3 + 6,
      onIdleError: () => {},
    });
  });
  afterAll(async () => {
    await db?.end();
  });

  it(
    "each connection's month is charged once, at the latest amount, whichever transaction wins",
    async () => {
      const s = await setupTenant(t.current, db);
      await setPolicy(t.current, s.op, "charge_full_month");
      const customers: string[] = [];
      const existing: string[] = [];
      for (let i = 0; i < CUSTOMERS; i += 1) {
        const c = await newCustomer(s, SEP_1);
        customers.push(c);
        existing.push(await connect(s, c, "2026-09-01", SEP_1, 30_000));
      }
      const before = await issuedSnapshot(s);

      const results = await Promise.all([
        runBilling(s, "2026-10-01", OCT_1).then(() => ({ ok: true as const })),
        ...customers.map((c, i) =>
          changeConnectionPlan.call(s.rt(OCT_1), s.staff, {
            assignmentId: existing[i] as string,
            effectiveDate: "2026-10-01",
            rentalPaise: 45_000,
          }),
        ),
        ...customers.map((c, i) =>
          addConnection.call(s.rt(OCT_1), s.owner, {
            customerId: c,
            vcNumber: `RACE${i}${c.slice(-6)}`,
            rentalPaise: 25_000,
            startDate: "2026-10-01",
          }),
        ),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      // Billing October again after the race changes nothing.
      const settled = await issuedSnapshot(s);
      await runBilling(s, "2026-10-01", OCT_1);
      expect(changedIssuedRows(settled, await issuedSnapshot(s))).toEqual([]);
      expect(changedIssuedRows(before, settled)).toEqual([]);

      const added = results
        .slice(1 + CUSTOMERS)
        .map((r) => (r as { ok: true; value: { connection: { assignmentId: string } } }).value);
      for (const [i, c] of customers.entries()) {
        for (const [assignmentId, expected] of [
          [existing[i] as string, 45_000],
          [added[i]?.connection.assignmentId as string, 25_000],
        ] as const) {
          const records = await s.tx((tx) => rentalRecordsOf(tx, s.op, assignmentId, [OCT]));
          const soFar = rentalChargedSoFar({
            assignmentId,
            period: OCT,
            records: records.get(OCT) ?? [],
          });
          expect(soFar.ok && soFar.value.chargedSoFarPaise, `customer ${c}`).toBe(expected);
        }
      }
      expect(await ledgerProblems(s, customers)).toEqual({});
    },
    180_000,
  );
});
