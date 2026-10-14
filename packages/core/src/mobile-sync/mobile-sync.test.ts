/**
 * Mobile sync services (T-060) against a real database with an injected clock.
 *
 * The delta tests drive a small model of the phone (T-064's rules: a full pass replaces the
 * roster, a delta upserts unless the stored copy is newer and deletes tombstones) and check that,
 * after any mix of changes — between pages, concurrently with paging, or committed late by a
 * transaction whose clock is behind — the phone ends up **exactly** equal to a fresh full sync.
 */
import { ROSTER_PAGE_MAX } from "@cb/contracts";
import type { Tx } from "@cb/db";
import { uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createArea, renameArea } from "../areas";
import { addConnection, disconnectConnection, suspendConnection } from "../connections";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import {
  createCustomer,
  setCustomerStatus,
  updateCustomer,
  updateCustomerPhone,
} from "../customers";
import { postPayment, reversePayment } from "../payments";
import { issueInvoice } from "../payments/test-support";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  getRosterCustomer,
  getRosterCustomerDetail,
  ROSTER_PAGE_SIZE,
  syncRoster,
} from "./services";
import type { RosterPage, RosterRow } from "./types";

/** 11:30 in India on 13 Oct 2026. */
const START = new Date("2026-10-13T06:00:00.000Z");
const TODAY = "2026-10-13";

interface Clock {
  now: Date;
  advance(ms: number): void;
}

interface Setup {
  tenant: SeededTenant;
  rt: ServiceRuntime;
  clock: Clock;
  owner: TenantContext;
  staff: TenantContext;
  lineman: TenantContext;
}

/** What the phone holds (T-064 RosterStore rules). */
class PhoneModel {
  readonly rows = new Map<string, RosterRow>();
  cursor: string | undefined;

  /** Applies one complete sync (all its pages) the way T-064 does. */
  apply(pages: readonly RosterPage[], full: boolean): void {
    if (full) {
      const received = new Set<string>();
      for (const page of pages) {
        for (const c of page.customers) received.add(c.id);
        for (const id of page.removedCustomerIds) received.delete(id);
        this.upsert(page.customers);
        for (const id of page.removedCustomerIds) this.rows.delete(id);
      }
      for (const id of [...this.rows.keys()]) if (!received.has(id)) this.rows.delete(id);
    } else {
      for (const page of pages) {
        this.upsert(page.customers);
        for (const id of page.removedCustomerIds) this.rows.delete(id);
      }
    }
    this.cursor = pages.at(-1)?.nextCursor;
  }

  private upsert(rows: readonly RosterRow[]) {
    for (const row of rows) {
      const stored = this.rows.get(row.id);
      if (stored && stored.updatedAt.getTime() > row.updatedAt.getTime()) continue;
      if (row.active) this.rows.set(row.id, row);
      else this.rows.delete(row.id);
    }
  }
}

describeDb("mobile sync services (T-060)", () => {
  const t = useTestDatabase();

  async function setup(options: { subscription?: "read_only" } = {}): Promise<Setup> {
    const tenant = await seedTenant(
      t.current,
      options.subscription ? { subscription: options.subscription } : {},
    );
    const clock: Clock = {
      now: START,
      advance(ms) {
        clock.now = new Date(clock.now.getTime() + ms);
      },
    };
    const rt = testRuntime(t.current.db, { now: () => clock.now });
    return {
      tenant,
      rt,
      clock,
      owner: await contextFor(rt, tenant, "owner"),
      staff: await contextFor(rt, tenant, "staff"),
      lineman: await contextFor(rt, tenant, "lineman"),
    };
  }

  const tenantTx = <T>(s: Setup, fn: (tx: Tx) => Promise<T>) =>
    t.current.db.withTenant(s.tenant.operatorId, fn);

  async function newCustomer(
    s: Setup,
    input: { name?: string; phone?: string; areaId?: string; code?: string } = {},
  ): Promise<string> {
    s.clock.advance(1_000);
    const r = await createCustomer.call(s.rt, s.owner, {
      name: input.name ?? `Customer ${uuidv7().slice(-5)}`,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.areaId ? { areaId: input.areaId } : {}),
      ...(input.code ? { customerCode: input.code } : {}),
    });
    if (!r.ok) throw new Error(`createCustomer: ${JSON.stringify(r.error)}`);
    return r.value.customer.id;
  }

  async function page(s: Setup, ctx: TenantContext, cursor?: string, limit?: number) {
    const r = await syncRoster.call(s.rt, ctx, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (!r.ok) throw new Error(`syncRoster: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  /** Pages until has_more is false (at most 100 pages). */
  async function syncAll(s: Setup, cursor?: string, limit?: number, ctx = s.lineman) {
    const pages: RosterPage[] = [];
    let next = cursor;
    for (let i = 0; i < 100; i += 1) {
      const p = await page(s, ctx, next, limit);
      pages.push(p);
      next = p.nextCursor;
      if (!p.hasMore) return pages;
    }
    throw new Error("sync did not finish");
  }

  /** The server's truth: a fresh full sync, as id → row. */
  async function truth(s: Setup): Promise<Map<string, RosterRow>> {
    const map = new Map<string, RosterRow>();
    for (const p of await syncAll(s, undefined, 7)) for (const c of p.customers) map.set(c.id, c);
    return map;
  }

  async function expectPhoneInSync(s: Setup, phone: PhoneModel) {
    // A final delta (the phone's next pull) brings everything committed so far.
    phone.apply(await syncAll(s, phone.cursor), false);
    const server = await truth(s);
    expect([...phone.rows.keys()].sort()).toEqual([...server.keys()].sort());
    for (const [id, row] of server) expect(phone.rows.get(id)).toEqual(row);
  }

  /** The service result's value, or a thrown error (setup steps must succeed). */
  async function must<T>(
    result: Promise<{ ok: true; value: T } | { ok: false; error: { code: string } }>,
  ): Promise<T> {
    const r = await result;
    if (!r.ok) throw new Error(`service failed: ${r.error.code}`);
    return r.value;
  }

  const ids = (pages: readonly RosterPage[]) => pages.flatMap((p) => p.customers.map((c) => c.id));

  /**
   * The delta contains every id in `changed`. Any other row is a re-sent, unchanged copy: the
   * cursor keeps the snapshot xmin, so while older transactions run on the server (other test
   * files share the Postgres cluster) recent rows can come again. That overlap is by design.
   */
  function expectChanges(pages: readonly RosterPage[], phone: PhoneModel, changed: string[]) {
    expect(ids(pages)).toEqual(expect.arrayContaining(changed));
    for (const row of pages.flatMap((p) => p.customers)) {
      if (!changed.includes(row.id)) expect(row).toEqual(phone.rows.get(row.id));
    }
  }
  const removed = (pages: readonly RosterPage[]) => pages.flatMap((p) => p.removedCustomerIds);

  it("uses the contract's page size", () => {
    expect(ROSTER_PAGE_SIZE).toBe(ROSTER_PAGE_MAX);
  });

  describe("full sync", () => {
    it("pages through every active customer once, without tombstones", async () => {
      const s = await setup();
      const active: string[] = [];
      for (let i = 0; i < 7; i += 1) active.push(await newCustomer(s));
      const closed = await newCustomer(s);
      const r = await setCustomerStatus.call(s.rt, s.owner, {
        customerId: closed,
        status: "inactive",
      });
      expect(r.ok).toBe(true);

      const pages = await syncAll(s, undefined, 3);
      expect(pages.map((p) => [p.customers.length, p.hasMore])).toEqual([
        [3, true],
        [3, true],
        [1, false],
      ]);
      expect(ids(pages).sort()).toEqual([...active].sort());
      expect(removed(pages)).toEqual([]);
      for (const p of pages) expect(p.nextCursor.length).toBeLessThanOrEqual(512);
      // Inside a page: (updated_at, id) order.
      for (const p of pages) {
        const keys = p.customers.map((c) => [c.updatedAt.getTime(), c.id] as const);
        expect([...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))).toEqual(keys);
      }
    });

    it("an empty tenant answers one empty page with a cursor", async () => {
      const s = await setup();
      const [only] = await syncAll(s);
      expect(only).toMatchObject({ customers: [], removedCustomerIds: [], hasMore: false });
      expect(decodeCursor(only?.nextCursor ?? "")).toMatchObject({ full: false });
    });

    it("works for every role and in a read-only tenant (D-13: viewing and collecting go on)", async () => {
      const s = await setup({ subscription: "read_only" });
      // createCustomer is refused in read-only mode: seed through the database.
      const id = uuidv7();
      await t.current.admin.query(
        "INSERT INTO customers (id, operator_id, customer_code, name) VALUES ($1, $2, 'RO-1', 'Read Only')",
        [id, s.tenant.operatorId],
      );
      for (const ctx of [s.owner, s.staff, s.lineman]) {
        expect(ids(await syncAll(s, undefined, undefined, ctx))).toEqual([id]);
        const detail = await getRosterCustomerDetail.call(s.rt, ctx, { customerId: id });
        expect(detail.ok).toBe(true);
      }
      // The phone correction is a write outside the D-13 allowlist.
      const phone = await updateCustomerPhone.call(s.rt, s.lineman, {
        customerId: id,
        phone: "9876543210",
      });
      expect(phone.ok ? "ok" : phone.error.code).toBe("TENANT_READ_ONLY");
    });
  });

  describe("delta sync", () => {
    it("an idle delta changes nothing on the phone", async () => {
      const s = await setup();
      for (let i = 0; i < 3; i += 1) await newCustomer(s);
      const phone = new PhoneModel();
      phone.apply(await syncAll(s), true);
      const stored = new Map(phone.rows);
      const pages = await syncAll(s, phone.cursor);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({ removedCustomerIds: [], hasMore: false });
      // The cursor keeps the snapshot xmin, so a row written shortly before the sync can come
      // again while older transactions (any tenant's) are still running on the server: the same
      // copy, an idempotent upsert. Nothing changed is ever invented.
      for (const row of pages[0]?.customers ?? []) expect(row).toEqual(stored.get(row.id));
      const later = await syncAll(s, pages[0]?.nextCursor);
      for (const row of later[0]?.customers ?? []) expect(row).toEqual(stored.get(row.id));
    });

    it("sends creates, edits, closes, reopenings, connections, money and area renames", async () => {
      const s = await setup();
      const area = await createArea.call(s.rt, s.owner, { name: "Shiv Nagar" });
      if (!area.ok) throw new Error("area");
      const areaId = area.value.id;
      const inArea = await newCustomer(s, { areaId, name: "Ramesh Kumar" });
      const edited = await newCustomer(s, { name: "Sunita Devi" });
      const toClose = await newCustomer(s);
      const toReopen = await newCustomer(s);
      const connected = await newCustomer(s);
      const payer = await newCustomer(s);
      const untouched = await newCustomer(s);
      await must(
        setCustomerStatus.call(s.rt, s.owner, { customerId: toReopen, status: "inactive" }),
      );
      await tenantTx(s, (tx) =>
        issueInvoice(tx, s.tenant.operatorId, payer, {
          period: "2026-10-01",
          chargesPaise: 45_000,
        }),
      );

      const phone = new PhoneModel();
      phone.apply(await syncAll(s), true);
      expect(phone.rows.has(toReopen)).toBe(false);
      const before = new Map(phone.rows);

      s.clock.advance(60_000);
      const created = await newCustomer(s, { name: "Naya Grahak" });
      await must(
        updateCustomer.call(s.rt, s.owner, { customerId: edited, name: "Sunita Devi Sharma" }),
      );
      await must(
        setCustomerStatus.call(s.rt, s.owner, { customerId: toClose, status: "inactive" }),
      );
      await must(setCustomerStatus.call(s.rt, s.owner, { customerId: toReopen, status: "active" }));
      const vc = await addConnection.call(s.rt, s.owner, {
        customerId: connected,
        vcNumber: "000123456789",
        rentalPaise: 30_000,
        startDate: TODAY,
      });
      if (!vc.ok) throw new Error(`addConnection: ${JSON.stringify(vc.error)}`);
      await must(renameArea.call(s.rt, s.owner, { areaId, name: "Shiv Nagar East" }));
      s.clock.advance(1_000);
      const paid = await postPayment.call(s.rt, s.lineman, {
        id: uuidv7(),
        customerId: payer,
        amountPaise: 20_000,
        method: "cash",
        recordedAt: new Date(s.clock.now.getTime() - 60_000).toISOString(),
        provisionalRef: "P-K7Q-0001",
        claimedCollectorId: s.tenant.users.lineman,
        claimedDeviceId: s.tenant.deviceId,
      });
      if (!paid.ok) throw new Error(`postPayment: ${JSON.stringify(paid.error)}`);

      const delta = await syncAll(s, phone.cursor);
      expectChanges(delta, phone, [created, edited, toReopen, connected, inArea, payer]);
      expect(removed(delta)).toEqual([toClose]);
      for (const row of delta.flatMap((p) => p.customers)) {
        if (row.id === untouched) expect(row).toEqual(before.get(untouched));
      }
      phone.apply(delta, false);

      expect(phone.rows.get(edited)?.name).toBe("Sunita Devi Sharma");
      expect(phone.rows.get(inArea)?.area?.name).toBe("Shiv Nagar East");
      expect(phone.rows.get(connected)?.connections).toEqual([
        { vcNumber: "000123456789", status: "active" },
      ]);
      const payerRow = phone.rows.get(payer);
      expect(payerRow).toMatchObject({
        balancePaise: 25_000,
        creditPaise: 0,
        openBills: { count: 1, outstandingPaise: 25_000, oldestPeriod: "2026-10-01" },
      });
      // T-064's projection: a posted payment is in the balance once updated_at >= posted_at.
      expect(payerRow?.updatedAt.getTime()).toBeGreaterThanOrEqual(
        paid.value.payment.postedAt.getTime(),
      );
      for (const id of [edited, inArea, payer]) {
        expect(phone.rows.get(id)?.updatedAt.getTime()).toBeGreaterThan(
          before.get(id)?.updatedAt.getTime() ?? Number.POSITIVE_INFINITY,
        );
      }

      // Suspending shows as a status, removing drops the connection; reversing restores the due.
      await must(
        suspendConnection.call(s.rt, s.owner, {
          assignmentId: vc.value.connection.assignmentId,
          effectiveDate: TODAY,
        }),
      );
      let next = await syncAll(s, phone.cursor);
      phone.apply(next, false);
      expect(phone.rows.get(connected)?.connections).toEqual([
        { vcNumber: "000123456789", status: "suspended" },
      ]);
      await must(
        disconnectConnection.call(s.rt, s.owner, {
          assignmentId: vc.value.connection.assignmentId,
          effectiveDate: TODAY,
          reason: "moved_away",
        }),
      );
      const reversed = await reversePayment.call(s.rt, s.owner, {
        paymentId: paid.value.payment.id,
        reason: "wrong customer",
      });
      expect(reversed.ok).toBe(true);
      next = await syncAll(s, phone.cursor);
      expectChanges(next, phone, [connected, payer]);
      phone.apply(next, false);
      expect(phone.rows.get(connected)?.connections).toEqual([]);
      expect(phone.rows.get(payer)?.balancePaise).toBe(45_000);
      await expectPhoneInSync(s, phone);
    });

    it("never loses changes made between the pages of a pass", async () => {
      const s = await setup();
      const all: string[] = [];
      for (let i = 0; i < 9; i += 1) all.push(await newCustomer(s, { name: `Grahak ${i}` }));
      const phone = new PhoneModel();

      // Full pass, 2 rows per page, with writes after each page.
      const pages: RosterPage[] = [];
      let cursor: string | undefined;
      let step = 0;
      const extra: string[] = [];
      do {
        const p = await page(s, s.lineman, cursor, 2);
        pages.push(p);
        cursor = p.nextCursor;
        step += 1;
        s.clock.advance(5_000);
        const sent = p.customers[0]?.id;
        if (sent)
          await must(
            updateCustomer.call(s.rt, s.owner, { customerId: sent, name: `Changed ${step}` }),
          );
        const later = all[all.length - step];
        if (later)
          await must(
            updateCustomer.call(s.rt, s.owner, { customerId: later, address: `Gali ${step}` }),
          );
        if (step === 2 && sent) {
          await must(
            setCustomerStatus.call(s.rt, s.owner, { customerId: sent, status: "inactive" }),
          );
        }
        if (step % 2 === 1) extra.push(await newCustomer(s, { name: `Late ${step}` }));
        if (!p.hasMore) break;
      } while (pages.length < 50);
      phone.apply(pages, true);
      await expectPhoneInSync(s, phone);
      for (const id of extra) expect(phone.rows.has(id)).toBe(true);
    });

    it("does not skip a transaction that commits after a later one was synced (late commit)", async () => {
      const s = await setup();
      const late = await newCustomer(s, { name: "Pehle Wala" });
      const other = await newCustomer(s, { name: "Doosra" });
      const phone = new PhoneModel();
      phone.apply(await syncAll(s), true);
      const lateBefore = phone.rows.get(late);

      // A slow transaction starts first, with an older clock, and holds its change uncommitted.
      const slow = await t.current.admin.connect();
      let open = true;
      try {
        await slow.query("BEGIN");
        await slow.query(
          "UPDATE customers SET name = 'Der Se Aaya', updated_at = $2 WHERE id = $1",
          [late, new Date(START.getTime() - 3_600_000).toISOString()],
        );
        // Meanwhile a quick change commits and the phone syncs it.
        s.clock.advance(120_000);
        await must(updateCustomer.call(s.rt, s.owner, { customerId: other, name: "Doosra Naam" }));
        const meanwhile = await syncAll(s, phone.cursor);
        expect(ids(meanwhile)).toContain(other);
        // The uncommitted change is invisible (a re-sent copy of `late` is still the old one).
        for (const row of meanwhile.flatMap((p) => p.customers)) {
          if (row.id === late) expect(row).toEqual(lateBefore);
        }
        phone.apply(meanwhile, false);
        await slow.query("COMMIT");
        open = false;
      } finally {
        if (open) await slow.query("ROLLBACK");
        slow.release();
      }

      const after = await syncAll(s, phone.cursor);
      expect(ids(after)).toContain(late);
      phone.apply(after, false);
      const lateRow = phone.rows.get(late);
      expect(lateRow?.name).toBe("Der Se Aaya");
      // updated_at never goes backwards for a customer…
      expect(lateRow?.updatedAt.getTime()).toBeGreaterThan(lateBefore?.updatedAt.getTime() ?? 0);
      // …yet it is older than the change synced before it: an (updated_at, id) cursor would have
      // skipped this row for good.
      expect(lateRow?.updatedAt.getTime()).toBeLessThan(
        phone.rows.get(other)?.updatedAt.getTime() ?? 0,
      );
      await expectPhoneInSync(s, phone);
    });

    it("stays exact while writers run concurrently with paging", { timeout: 120_000 }, async () => {
      const s = await setup();
      const all: string[] = [];
      for (let i = 0; i < 30; i += 1) all.push(await newCustomer(s, { name: `Grahak ${i}` }));
      const phone = new PhoneModel();
      phone.apply(await syncAll(s, undefined, 4), true);

      let writing = true;
      const writer = (async () => {
        let n = 0;
        while (writing && n < 200) {
          n += 1;
          const target = all[n % all.length] as string;
          s.clock.advance(10);
          if (n % 7 === 0) {
            await must(
              setCustomerStatus.call(s.rt, s.owner, {
                customerId: target,
                status: n % 14 === 0 ? "active" : "inactive",
              }),
            );
          } else if (n % 11 === 0) {
            all.push(await newCustomer(s, { name: `Naya ${n}` }));
          } else {
            await must(
              updateCustomer.call(s.rt, s.owner, { customerId: target, address: `Gali ${n}` }),
            );
          }
        }
      })();
      for (let round = 0; round < 8; round += 1) {
        phone.apply(await syncAll(s, phone.cursor, 3), false);
      }
      writing = false;
      await writer;
      await expectPhoneInSync(s, phone);
    });
  });

  describe("cursor", () => {
    it("refuses a malformed cursor, another tenant's, another version and one from the future", async () => {
      const s = await setup();
      const other = await setup();
      await newCustomer(other);
      const theirs = (await syncAll(other))[0]?.nextCursor ?? "";
      const raw = (body: object) => Buffer.from(JSON.stringify(body)).toString("base64url");
      const bad = [
        "not a cursor",
        "e30",
        theirs,
        raw({ v: 2, o: s.tenant.operatorId, w: "0" }),
        raw({ v: 1, o: s.tenant.operatorId, w: "-1" }),
        encodeCursor({ operatorId: s.tenant.operatorId, watermark: "99999999999999", full: false }),
      ];
      for (const cursor of bad) {
        const r = await syncRoster.call(s.rt, s.lineman, { cursor });
        expect(r.ok ? "ok" : r.error.code).toBe("CURSOR_INVALID");
        if (!r.ok) expect(JSON.stringify(r.error)).not.toContain(other.tenant.operatorId);
      }
    });
  });

  describe("customer detail", () => {
    let s: Setup;
    let customerId: string;
    let paymentIds: string[];

    beforeAll(async () => {
      s = await setup();
      const area = await createArea.call(s.rt, s.owner, { name: "Ram Nagar" });
      if (!area.ok) throw new Error("area");
      customerId = await newCustomer(s, {
        name: "Ramesh Kumar",
        phone: "9876543210",
        areaId: area.value.id,
        code: "1045",
      });
      const first = await addConnection.call(s.rt, s.owner, {
        customerId,
        vcNumber: "000123456789",
        rentalPaise: 45_000,
        startDate: "2026-08-01",
      });
      const second = await addConnection.call(s.rt, s.owner, {
        customerId,
        vcNumber: "000123456790",
        rentalPaise: 0,
        startDate: "2026-09-01",
      });
      const third = await addConnection.call(s.rt, s.owner, {
        customerId,
        vcNumber: "000123456791",
        rentalPaise: 0,
        startDate: "2026-09-02",
      });
      if (!first.ok || !second.ok || !third.ok) throw new Error("connections");
      await must(
        suspendConnection.call(s.rt, s.owner, {
          assignmentId: second.value.connection.assignmentId,
          effectiveDate: TODAY,
        }),
      );
      await must(
        disconnectConnection.call(s.rt, s.owner, {
          assignmentId: third.value.connection.assignmentId,
          effectiveDate: TODAY,
          reason: "moved_away",
        }),
      );
      for (const period of ["2026-08-01", "2026-09-01", "2026-10-01"]) {
        await tenantTx(s, (tx) =>
          issueInvoice(tx, s.tenant.operatorId, customerId, { period, chargesPaise: 45_000 }),
        );
      }
      paymentIds = [];
      for (let i = 1; i <= 12; i += 1) {
        s.clock.advance(60_000);
        const viaPhone = i % 2 === 0;
        const r = await postPayment.call(s.rt, viaPhone ? s.lineman : s.owner, {
          id: uuidv7(),
          customerId,
          amountPaise: 5_000,
          method: viaPhone ? "cash" : "upi",
          ...(viaPhone
            ? {
                recordedAt: new Date(s.clock.now.getTime() - 30_000).toISOString(),
                provisionalRef: `P-K7Q-${String(i).padStart(4, "0")}`,
                claimedCollectorId: s.tenant.users.lineman,
                claimedDeviceId: s.tenant.deviceId,
              }
            : {}),
        });
        if (!r.ok) throw new Error(`postPayment: ${JSON.stringify(r.error)}`);
        paymentIds.push(r.value.payment.id);
      }
      s.clock.advance(60_000);
      const rev = await reversePayment.call(s.rt, s.owner, {
        paymentId: paymentIds.at(-1) ?? "",
        reason: "counted twice",
      });
      if (!rev.ok) throw new Error("reverse");
    });

    it("answers the roster row with open bills (oldest first) and the latest payments", async () => {
      const r = await getRosterCustomerDetail.call(s.rt, s.lineman, { customerId });
      if (!r.ok) throw new Error(r.error.code);
      const { customer, openBills, recentPayments } = r.value;
      // 3 × 450 billed, 11 × 50 paid (the 12th was reversed): 135000 − 55000 = 80000 due.
      expect(customer).toMatchObject({
        id: customerId,
        code: "1045",
        name: "Ramesh Kumar",
        phone: "9876543210",
        area: { name: "Ram Nagar" },
        active: true,
        balancePaise: 80_000,
        creditPaise: 0,
        connections: [
          { vcNumber: "000123456789", status: "active" },
          { vcNumber: "000123456790", status: "suspended" },
        ],
        openBills: { count: 2, outstandingPaise: 80_000, oldestPeriod: "2026-09-01" },
      });
      expect(openBills.map((b) => [b.period, b.chargesPaise, b.outstandingPaise])).toEqual([
        ["2026-09-01", 45_000, 35_000],
        ["2026-10-01", 45_000, 45_000],
      ]);
      expect(recentPayments).toHaveLength(10);
      expect(recentPayments.map((p) => p.paymentId)).toEqual(paymentIds.slice(2).reverse());
      const [newest, second] = recentPayments;
      expect(newest).toMatchObject({
        reversed: true,
        method: "cash",
        provisionalRef: "P-K7Q-0012",
        amountPaise: 5_000,
      });
      expect(newest?.receiptNumber).toMatch(/^R-2610-\d{5}$/);
      expect(newest?.collectedByName).toBeTruthy();
      expect(second).toMatchObject({ reversed: false, method: "upi", provisionalRef: null });
      for (const p of recentPayments) expect(p.postedAt.getTime()).toBeGreaterThan(0);
    });

    it("the single roster row equals the detail's and the roster's", async () => {
      const row = await getRosterCustomer.call(s.rt, s.lineman, { customerId });
      const detail = await getRosterCustomerDetail.call(s.rt, s.lineman, { customerId });
      const roster = (await syncAll(s))
        .flatMap((p) => p.customers)
        .find((c) => c.id === customerId);
      expect(row.ok && detail.ok).toBe(true);
      if (row.ok && detail.ok) {
        expect(row.value).toEqual(detail.value.customer);
        expect(roster).toEqual(row.value);
      }
    });

    it("answers a closed customer as inactive, and NOT_FOUND for unknown ids", async () => {
      const closed = await newCustomer(s);
      await must(setCustomerStatus.call(s.rt, s.owner, { customerId: closed, status: "inactive" }));
      const r = await getRosterCustomerDetail.call(s.rt, s.lineman, { customerId: closed });
      expect(r.ok && r.value.customer.active).toBe(false);
      for (const service of [getRosterCustomerDetail, getRosterCustomer]) {
        const missing = await service.call(s.rt, s.lineman, { customerId: uuidv7() });
        expect(missing.ok ? "ok" : missing.error.code).toBe("NOT_FOUND");
      }
    });

    it("clips over-long legacy values to the contract's limits", async () => {
      const id = uuidv7();
      await t.current.admin.query(
        "INSERT INTO customers (id, operator_id, customer_code, name, address) VALUES ($1, $2, $3, $4, $5)",
        [id, s.tenant.operatorId, `L-${id.slice(-6)}`, "न".repeat(250), "x".repeat(800)],
      );
      const r = await getRosterCustomer.call(s.rt, s.lineman, { customerId: id });
      if (!r.ok) throw new Error(r.error.code);
      expect(r.value.name).toHaveLength(200);
      expect(r.value.address).toHaveLength(500);
    });
  });

  describe("phone correction (T-033 service, source android)", () => {
    it("is audited with the contact history once, and changes nothing when repeated", async () => {
      const s = await setup();
      const id = await newCustomer(s, { phone: "9876543210" });
      const before = (await getRosterCustomer.call(s.rt, s.lineman, { customerId: id })) as {
        ok: true;
        value: RosterRow;
      };
      s.clock.advance(60_000);
      const first = await updateCustomerPhone.call(s.rt, s.lineman, {
        customerId: id,
        phone: "9876543211",
      });
      expect(first.ok && first.value.changed).toEqual(["phone"]);
      const again = await updateCustomerPhone.call(s.rt, s.lineman, {
        customerId: id,
        phone: "9876543211",
      });
      expect(again.ok && again.value.changed).toEqual([]);
      const history = await t.current.admin.query(
        "SELECT old_value, new_value, source, actor_id FROM customer_contact_changes WHERE customer_id = $1",
        [id],
      );
      expect(history.rows).toEqual([
        {
          old_value: "9876543210",
          new_value: "9876543211",
          source: "android",
          actor_id: s.tenant.users.lineman,
        },
      ]);
      const audit = await t.current.admin.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = 'customers.update_phone'",
        [id],
      );
      expect(audit.rows[0]?.n).toBe(1);
      const after = await getRosterCustomer.call(s.rt, s.lineman, { customerId: id });
      expect(after.ok && after.value.phone).toBe("9876543211");
      expect(after.ok && after.value.updatedAt.getTime()).toBeGreaterThan(
        before.value.updatedAt.getTime(),
      );
    });
  });

  it("read-only mode does not apply to reads once the subscription lapses", async () => {
    const s = await setup();
    const id = await newCustomer(s);
    await setSubscriptionStatus(t.current, s.tenant.operatorId, "cancelled");
    expect(ids(await syncAll(s))).toEqual([id]);
  });
});
