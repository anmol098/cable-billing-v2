/**
 * Customer services against a real database (T-033): create with typed and automatic codes,
 * duplicate codes (friendly error and the race), edits with the FR-004 phone history, the
 * deactivation rule, the profile summary, roles and read-only mode.
 */
import {
  areas,
  auditEvents,
  customerBalances,
  customerContactChanges,
  customers,
  type Tx,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { postPayment } from "../payments/post-payment";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import {
  createCustomer,
  isDuplicateCustomerCode,
  setCustomerStatus,
  updateCustomer,
  updateCustomerPhone,
} from "./customers";
import { customerFormOptions, getCustomer } from "./queries";

const NOW = new Date("2026-10-13T06:00:00.000Z");
const LATER = new Date("2026-10-14T06:00:00.000Z");

describeDb("customer services", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
  }

  async function setup(now: Date = NOW): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(t.current.db, { now: () => now });
    return {
      tenant,
      rt,
      owner: await contextFor(rt, tenant, "owner"),
      staff: await contextFor(rt, tenant, "staff"),
      lineman: await contextFor(rt, tenant, "lineman"),
    };
  }

  const tenantTx = <T>(s: Setup, fn: (tx: Tx) => Promise<T>) =>
    t.current.db.withTenant(s.tenant.operatorId, fn);

  async function addArea(s: Setup, name: string, archived = false) {
    const id = uuidv7();
    await tenantTx(s, (tx) =>
      tx.insert(areas).values({
        id,
        operatorId: s.tenant.operatorId,
        name,
        archivedAt: archived ? NOW : null,
      }),
    );
    return id;
  }

  async function create(s: Setup, input: Parameters<typeof createCustomer.call>[2]) {
    const result = await createCustomer.call(s.rt, s.staff, input);
    if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result.error)}`);
    return result.value.customer;
  }

  async function auditOf(s: Setup, entityId: string) {
    return tenantTx(s, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, entityId))
        .orderBy(asc(auditEvents.at), asc(auditEvents.id)),
    );
  }

  async function contactChanges(s: Setup, customerId: string) {
    return tenantTx(s, (tx) =>
      tx
        .select()
        .from(customerContactChanges)
        .where(eq(customerContactChanges.customerId, customerId))
        .orderBy(asc(customerContactChanges.at), asc(customerContactChanges.id)),
    );
  }

  async function customerCount(s: Setup) {
    const r = await t.current.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM customers WHERE operator_id = $1",
      [s.tenant.operatorId],
    );
    return r.rows[0]?.n ?? 0;
  }

  describe("customers.create", () => {
    it("saves a customer with a typed code, cleans the phones and audits it", async () => {
      const s = await setup();
      const areaId = await addArea(s, "Gandhi Nagar");
      const result = await createCustomer.call(s.rt, s.staff, {
        customerCode: "  a-101 ",
        name: "  Ramesh Kumar ",
        phone: "+91 98765-43210",
        altPhone: "",
        address: " 12, Main Road ",
        areaId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { customer, autoCode } = result.value;
      expect(autoCode).toBe(false);
      expect(customer).toMatchObject({
        customerCode: "a-101",
        name: "Ramesh Kumar",
        phone: "9876543210",
        altPhone: null,
        address: "12, Main Road",
        areaId,
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const [row] = await tenantTx(s, (tx) =>
        tx.select().from(customers).where(eq(customers.id, customer.id)),
      );
      expect(row?.customerCodeNorm).toBe("A-101");

      const audit = await auditOf(s, customer.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "customers.create",
        entityType: "customer",
        actorId: s.tenant.users.staff,
        actorRole: "staff",
      });
      expect(audit[0]?.after).toMatchObject({ customerCode: "a-101", phone: "9876543210" });
      // The first numbers are in the audit event; the history starts with the first change.
      expect(await contactChanges(s, customer.id)).toEqual([]);
    });

    it("refuses a code that is already used (after normalising) with a friendly error", async () => {
      const s = await setup();
      const first = await create(s, { customerCode: "A 101", name: "First" });
      const before = await customerCount(s);
      const result = await createCustomer.call(s.rt, s.owner, {
        customerCode: " a   101",
        name: "Second",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "CONFLICT",
        details: { field: "customerCode", reason: "duplicate_code", customerId: first.id },
      });
      expect(isDuplicateCustomerCode(result.error)).toBe(true);
      expect(await customerCount(s)).toBe(before);
      // "0101" and "101" are different codes (T-022).
      await create(s, { customerCode: "101", name: "Third" });
      await create(s, { customerCode: "0101", name: "Fourth" });
    });

    it("allows the same code at another operator (RULE-02)", async () => {
      const a = await setup();
      const b = await setup();
      await create(a, { customerCode: "1045", name: "At A" });
      const atB = await create(b, { customerCode: "1045", name: "At B" });
      expect(atB.customerCode).toBe("1045");
    });

    it("reports the race on the unique index as the same duplicate", async () => {
      const s = await setup();
      const results = await Promise.all(
        ["Left", "Right"].map((name) =>
          createCustomer.call(s.rt, s.staff, { customerCode: "RACE-1", name }),
        ),
      );
      const failed = results.filter((r) => !r.ok);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const error = failed[0];
      if (!error || error.ok) return;
      expect(isDuplicateCustomerCode(error.error)).toBe(true);
    });

    it("takes the next number when the code is empty, skipping numbers typed by hand", async () => {
      const s = await setup();
      expect((await create(s, { name: "Auto one" })).customerCode).toBe("1");
      expect((await create(s, { customerCode: "", name: "Auto two" })).customerCode).toBe("2");
      for (const code of ["3", "4", "50", "0060", "B7"]) {
        await create(s, { customerCode: code, name: `Typed ${code}` });
      }
      const options = await customerFormOptions.call(s.rt, s.staff, {});
      expect(options.ok && options.value.nextAutoCode).toBe("3");
      // 3 is taken: the counter moves past the highest all-digit code (50; "0060" isn't a number
      // the counter would make) and gives 51.
      const auto = await createCustomer.call(s.rt, s.staff, { name: "Auto three" });
      expect(auto.ok && auto.value).toMatchObject({
        autoCode: true,
        customer: { customerCode: "51" },
      });
      expect((await create(s, { name: "Auto four" })).customerCode).toBe("52");
    });

    it("gives parallel automatic codes distinct numbers", async () => {
      const s = await setup();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          createCustomer.call(s.rt, s.staff, { name: `Parallel ${i}` }),
        ),
      );
      const codes = results.map((r) => (r.ok ? r.value.customer.customerCode : r.error.code));
      expect(codes.toSorted((x, y) => Number(x) - Number(y))).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
      ]);
    }, 60_000);

    it("validates fields and names the field that is wrong", async () => {
      const s = await setup();
      const archived = await addArea(s, "Old Colony", true);
      const cases: [Parameters<typeof createCustomer.call>[2], string, string][] = [
        [{ name: "   " }, "name", "too_small"],
        [{ name: "X", phone: "98765abc" }, "phone", "custom"],
        [{ name: "X", altPhone: "12" }, "altPhone", "custom"],
        [{ name: "X", customerCode: "C".repeat(65) }, "customerCode", "custom"],
        [{ name: "X", areaId: archived }, "areaId", "archived"],
      ];
      for (const [input, path, code] of cases) {
        const result = await createCustomer.call(s.rt, s.staff, input);
        expect(result.ok, path).toBe(false);
        if (result.ok) continue;
        expect(result.error.code, path).toBe("VALIDATION");
        expect(result.error.details?.fields, path).toEqual([{ path, code }]);
      }
      expect(await customerCount(s)).toBe(0);
    });

    it("is for the Owner and Staff only, and not in read-only mode", async () => {
      const s = await setup();
      const lineman = await createCustomer.call(s.rt, s.lineman, { name: "Nope" });
      expect(lineman.ok || lineman.error.code).toBe("FORBIDDEN");
      await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
      const locked = await createCustomer.call(s.rt, s.owner, { name: "Nope" });
      expect(locked.ok || locked.error.code).toBe("TENANT_READ_ONLY");
      expect(await customerCount(s)).toBe(0);
    });
  });

  describe("customers.update", () => {
    it("changes only what is given, records phone history (source web) and audits the change", async () => {
      const s = await setup();
      const customer = await create(s, {
        customerCode: "77",
        name: "Sunita Devi",
        phone: "9876543210",
        altPhone: "9123456789",
      });
      const rt = testRuntime(t.current.db, { now: () => LATER });
      const owner = await contextFor(rt, s.tenant, "owner");
      const result = await updateCustomer.call(rt, owner, {
        customerId: customer.id,
        phone: "98111 22233",
        altPhone: null,
        name: "Sunita Devi",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.changed.toSorted()).toEqual(["altPhone", "phone"]);
      expect(result.value.customer).toMatchObject({
        name: "Sunita Devi",
        customerCode: "77",
        phone: "9811122233",
        altPhone: null,
        updatedAt: LATER,
      });

      const history = await contactChanges(s, customer.id);
      expect(history.map((h) => [h.field, h.oldValue, h.newValue, h.source, h.actorId])).toEqual(
        expect.arrayContaining([
          ["phone", "9876543210", "9811122233", "web", s.tenant.users.owner],
          ["alt_phone", "9123456789", null, "web", s.tenant.users.owner],
        ]),
      );
      expect(history.every((h) => h.at.getTime() === LATER.getTime())).toBe(true);

      const audit = await auditOf(s, customer.id);
      expect(audit.at(-1)).toMatchObject({
        action: "customers.update",
        before: { phone: "9876543210", altPhone: "9123456789" },
        after: { phone: "9811122233", altPhone: null },
      });
    });

    it("writes nothing when nothing changes", async () => {
      const s = await setup();
      const customer = await create(s, { customerCode: "5", name: "Same", phone: "9876543210" });
      const result = await updateCustomer.call(s.rt, s.staff, {
        customerId: customer.id,
        name: " Same ",
        phone: "+919876543210",
      });
      expect(result.ok && result.value.changed).toEqual([]);
      expect(await auditOf(s, customer.id)).toHaveLength(1);
      expect(await contactChanges(s, customer.id)).toEqual([]);
    });

    it("refuses another customer's code but lets a customer re-type its own", async () => {
      const s = await setup();
      const a = await create(s, { customerCode: "A-1", name: "A" });
      const b = await create(s, { customerCode: "B-1", name: "B" });
      const taken = await updateCustomer.call(s.rt, s.staff, {
        customerId: b.id,
        customerCode: "a-1",
      });
      expect(taken.ok).toBe(false);
      if (!taken.ok) {
        expect(taken.error.details).toMatchObject({ reason: "duplicate_code", customerId: a.id });
      }
      const own = await updateCustomer.call(s.rt, s.staff, {
        customerId: b.id,
        customerCode: "b-1",
      });
      expect(own.ok && own.value.customer.customerCode).toBe("b-1");
      const empty = await updateCustomer.call(s.rt, s.staff, {
        customerId: b.id,
        customerCode: " ",
      });
      expect(empty.ok || empty.error.code).toBe("VALIDATION");
    });

    it("moves a customer to another area, not to an archived one", async () => {
      const s = await setup();
      const north = await addArea(s, "North");
      const old = await addArea(s, "Old", true);
      const customer = await create(s, { name: "Mover" });
      const moved = await updateCustomer.call(s.rt, s.staff, {
        customerId: customer.id,
        areaId: north,
      });
      expect(moved.ok && moved.value.customer.areaId).toBe(north);
      const archived = await updateCustomer.call(s.rt, s.staff, {
        customerId: customer.id,
        areaId: old,
      });
      expect(archived.ok || archived.error.details).toEqual({
        fields: [{ path: "areaId", code: "archived" }],
      });
      const cleared = await updateCustomer.call(s.rt, s.staff, {
        customerId: customer.id,
        areaId: null,
      });
      expect(cleared.ok && cleared.value.customer.areaId).toBeNull();
    });
  });

  describe("customers.update_phone", () => {
    it("lets a lineman correct a number from the phone app (source android)", async () => {
      const s = await setup();
      const customer = await create(s, { name: "Field", phone: "9876543210" });
      const result = await updateCustomerPhone.call(s.rt, s.lineman, {
        customerId: customer.id,
        phone: "9000000001",
      });
      expect(result.ok && result.value.customer.phone).toBe("9000000001");
      const [change] = await contactChanges(s, customer.id);
      expect(change).toMatchObject({
        field: "phone",
        oldValue: "9876543210",
        newValue: "9000000001",
        source: "android",
        actorId: s.tenant.users.lineman,
      });
      const alt = await updateCustomerPhone.call(s.rt, s.staff, {
        customerId: customer.id,
        field: "alt_phone",
        phone: "9000000002",
      });
      expect(alt.ok && alt.value.customer.altPhone).toBe("9000000002");
      expect((await contactChanges(s, customer.id)).at(-1)).toMatchObject({
        field: "alt_phone",
        oldValue: null,
        source: "web",
      });
    });
  });

  describe("customers.set_status", () => {
    async function connect(s: Setup, customerId: string, status: "active" | "disconnected") {
      await tenantTx(s, async (tx) => {
        const vcAssetId = uuidv7();
        await tx.insert(vcAssets).values({
          id: vcAssetId,
          operatorId: s.tenant.operatorId,
          vcNumber: `VC${vcAssetId.slice(-10)}`,
        });
        await tx.insert(vcAssignments).values({
          id: uuidv7(),
          operatorId: s.tenant.operatorId,
          vcAssetId,
          customerId,
          startDate: "2026-01-01",
          endDate: status === "disconnected" ? "2026-06-30" : null,
          status,
          rentalAmountPaise: 30_000,
        });
      });
    }

    it("refuses to deactivate while a connection is not disconnected", async () => {
      const s = await setup();
      const customer = await create(s, { name: "Has TV" });
      await connect(s, customer.id, "active");
      const refused = await setCustomerStatus.call(s.rt, s.staff, {
        customerId: customer.id,
        status: "inactive",
      });
      expect(refused.ok || refused.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "open_connections", openConnections: 1 },
      });
    });

    it("deactivates and reactivates, auditing each change", async () => {
      const s = await setup();
      const customer = await create(s, { name: "Moved away" });
      await connect(s, customer.id, "disconnected");
      const off = await setCustomerStatus.call(s.rt, s.owner, {
        customerId: customer.id,
        status: "inactive",
      });
      expect(off.ok && off.value.customer.status).toBe("inactive");
      const again = await setCustomerStatus.call(s.rt, s.owner, {
        customerId: customer.id,
        status: "inactive",
      });
      expect(again.ok && again.value.changed).toEqual([]);
      const on = await setCustomerStatus.call(s.rt, s.staff, {
        customerId: customer.id,
        status: "active",
      });
      expect(on.ok && on.value.customer.status).toBe("active");
      const audit = await auditOf(s, customer.id);
      expect(audit.map((a) => [a.action, a.before, a.after])).toEqual([
        ["customers.create", null, expect.anything()],
        ["customers.set_status", { status: "active" }, { status: "inactive" }],
        ["customers.set_status", { status: "inactive" }, { status: "active" }],
      ]);
    });
  });

  describe("customers.get", () => {
    it("returns the profile summary: area, balance, open connections, last payment", async () => {
      const s = await setup();
      const areaId = await addArea(s, "Station Road");
      const customer = await create(s, { customerCode: "900", name: "Profile", areaId });
      const empty = await getCustomer.call(s.rt, s.lineman, { customerId: customer.id });
      expect(empty.ok && empty.value).toMatchObject({
        areaName: "Station Road",
        balancePaise: 0,
        creditPaise: 0,
        connections: [],
        pastConnections: 0,
        lastPayment: null,
      });

      await tenantTx(s, async (tx) => {
        const [one, two] = [uuidv7(), uuidv7()];
        await tx.insert(vcAssets).values([
          { id: one, operatorId: s.tenant.operatorId, vcNumber: "1111 2222 3333" },
          { id: two, operatorId: s.tenant.operatorId, vcNumber: "4444 5555 6666" },
        ]);
        await tx.insert(vcAssignments).values([
          {
            operatorId: s.tenant.operatorId,
            vcAssetId: one,
            customerId: customer.id,
            startDate: "2026-02-01",
            rentalAmountPaise: 35_000,
          },
          {
            operatorId: s.tenant.operatorId,
            vcAssetId: two,
            customerId: customer.id,
            startDate: "2025-01-01",
            endDate: "2026-01-31",
            status: "disconnected",
            rentalAmountPaise: 20_000,
          },
        ]);
      });
      const paid = await postPayment.call(s.rt, s.staff, {
        id: uuidv7(),
        customerId: customer.id,
        amountPaise: 50_000,
        method: "cash",
      });
      expect(paid.ok).toBe(true);

      const profile = await getCustomer.call(s.rt, s.owner, { customerId: customer.id });
      expect(profile.ok).toBe(true);
      if (!profile.ok) return;
      expect(profile.value).toMatchObject({
        customerCode: "900",
        balancePaise: -50_000,
        creditPaise: 50_000,
        pastConnections: 1,
        lastPayment: { amountPaise: 50_000, method: "cash", reversed: false },
      });
      expect(profile.value.connections).toEqual([
        expect.objectContaining({
          vcNumber: "1111 2222 3333",
          status: "active",
          planName: null,
          rentalPaise: 35_000,
          startDate: "2026-02-01",
          endDate: null,
        }),
      ]);
      const balance = await tenantTx(s, (tx) =>
        tx
          .select()
          .from(customerBalances)
          .where(and(eq(customerBalances.customerId, customer.id))),
      );
      expect(balance).toHaveLength(1);
    });

    it("answers NOT_FOUND for an unknown id", async () => {
      const s = await setup();
      const result = await getCustomer.call(s.rt, s.staff, { customerId: uuidv7() });
      expect(result.ok || result.error.code).toBe("NOT_FOUND");
    });
  });
});
