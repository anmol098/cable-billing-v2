/**
 * Area services against a real database (T-030): list with customer counts, add, rename (names
 * unique per operator ignoring case, archived ones included), archive and restore (idempotent,
 * customers keep their area), Owner only, read-only mode (D-13) and the audit trail.
 */
import { areas, auditEvents, customers, type SubscriptionStatus, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { databaseFingerprint } from "../testing/fingerprint";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import {
  AreaName,
  type AreaView,
  archiveArea,
  createArea,
  listAreas,
  renameArea,
  restoreArea,
} from "./areas";

const NOW = new Date("2026-10-13T06:00:00.000Z");

describe("area name rule (pure)", () => {
  it("collapses spaces and trims", () => {
    expect(AreaName.parse("  Station \t  Road ")).toBe("Station Road");
    expect(AreaName.parse("स्टेशन रोड")).toBe("स्टेशन रोड");
  });

  it.each([
    ["", "too_small"],
    ["   ", "too_small"],
    ["x".repeat(61), "too_big"],
    ["North\u0007", "custom"],
  ])("refuses %j (%s)", (name, code) => {
    const result = AreaName.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe(code);
  });
});

describeDb("area services", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
  }

  async function setup(subscription?: SubscriptionStatus | null): Promise<Setup> {
    const tenant = await seedTenant(t.current, subscription === undefined ? {} : { subscription });
    const rt = testRuntime(t.current.db, { now: () => NOW });
    return {
      tenant,
      rt,
      owner: await contextFor(rt, tenant, "owner"),
      staff: await contextFor(rt, tenant, "staff"),
      lineman: await contextFor(rt, tenant, "lineman"),
    };
  }

  async function add(s: Setup, name: string): Promise<AreaView> {
    const result = await createArea.call(s.rt, s.owner, { name });
    if (!result.ok) throw new Error(`add ${name}: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  async function addCustomer(s: Setup, areaId: string, status: "active" | "inactive" = "active") {
    const id = uuidv7();
    await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx.insert(customers).values({
        id,
        operatorId: s.tenant.operatorId,
        customerCode: `C-${id.slice(-8)}`,
        name: "Area customer",
        areaId,
        status,
      }),
    );
    return id;
  }

  async function auditFor(s: Setup, areaId: string) {
    return t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.operatorId, s.tenant.operatorId),
            eq(auditEvents.entityId, areaId),
            like(auditEvents.action, "areas.%"),
          ),
        )
        .orderBy(auditEvents.at, auditEvents.id),
    );
  }

  describe("areas.list", () => {
    it("lists areas in use by name, then hidden ones, with customer counts", async () => {
      const s = await setup();
      const south = await add(s, "south");
      const north = await add(s, "North");
      const old = await add(s, "Old market");
      await addCustomer(s, north.id);
      await addCustomer(s, north.id, "inactive");
      await addCustomer(s, old.id);
      expect((await archiveArea.call(s.rt, s.owner, { areaId: old.id })).ok).toBe(true);

      const result = await listAreas.call(s.rt, s.staff, {});
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.areas).toEqual([
        { id: north.id, name: "North", archivedAt: null, customerCount: 2 },
        { id: south.id, name: "south", archivedAt: null, customerCount: 0 },
        { id: old.id, name: "Old market", archivedAt: NOW, customerCount: 1 },
      ]);
      expect(result.value).toMatchObject({ editable: false, readOnlyReason: "not_owner" });

      const picker = await listAreas.call(s.rt, s.owner, { includeArchived: false });
      expect(picker.ok && picker.value.areas.map((a) => a.id)).toEqual([north.id, south.id]);
      expect(picker.ok && picker.value).toMatchObject({ editable: true, readOnlyReason: null });
    });

    it("is empty for a new tenant and refused for linemen", async () => {
      const s = await setup();
      const result = await listAreas.call(s.rt, s.owner, {});
      expect(result.ok && result.value.areas).toEqual([]);
      const lineman = await listAreas.call(s.rt, s.lineman, {});
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
    });

    it("tells the Owner when the tenant is read-only", async () => {
      const s = await setup("read_only");
      const result = await listAreas.call(s.rt, s.owner, {});
      expect(result.ok && result.value.readOnlyReason).toBe("tenant_read_only");
    });
  });

  describe("areas.create", () => {
    it("adds a tidy name and audits it", async () => {
      const s = await setup();
      const area = await add(s, "  Station   Road ");
      expect(area).toMatchObject({ name: "Station Road", archivedAt: null, customerCount: 0 });
      const audit = await auditFor(s, area.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "areas.create",
        entityType: "area",
        actorId: s.tenant.users.owner,
        actorRole: "owner",
        after: { name: "Station Road" },
      });
    });

    it("refuses a name in use (any capitals, hidden areas too) and writes nothing", async () => {
      const s = await setup();
      const north = await add(s, "North");
      await add(s, "Old market");
      const old = await listAreas.call(s.rt, s.owner, {});
      const oldId = old.ok ? old.value.areas.find((a) => a.name === "Old market")?.id : undefined;
      await archiveArea.call(s.rt, s.owner, { areaId: oldId ?? "" });
      const before = await databaseFingerprint(t.current);

      const clash = await createArea.call(s.rt, s.owner, { name: " NORTH " });
      expect(!clash.ok && clash.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "name_taken", archived: false },
      });
      const hidden = await createArea.call(s.rt, s.owner, { name: "old MARKET" });
      expect(!hidden.ok && hidden.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "name_taken", archived: true },
      });
      expect(await databaseFingerprint(t.current)).toEqual(before);
      expect(north.name).toBe("North");
    });

    it("allows the same name in another tenant", async () => {
      const a = await setup();
      const b = await setup();
      await add(a, "North");
      expect((await createArea.call(b.rt, b.owner, { name: "North" })).ok).toBe(true);
    });

    it("refuses a blank name with VALIDATION", async () => {
      const s = await setup();
      const result = await createArea.call(s.rt, s.owner, { name: "  " });
      expect(!result.ok && result.error).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "name", code: "too_small" }] },
      });
    });
  });

  describe("areas.rename", () => {
    it("renames (customers follow the area) and audits old and new names", async () => {
      const s = await setup();
      const area = await add(s, "Nort");
      await addCustomer(s, area.id);
      const result = await renameArea.call(s.rt, s.owner, { areaId: area.id, name: "North" });
      expect(result.ok && result.value).toEqual({
        id: area.id,
        name: "North",
        archivedAt: null,
        customerCount: 1,
      });
      const audit = await auditFor(s, area.id);
      expect(audit.at(-1)).toMatchObject({
        action: "areas.rename",
        before: { name: "Nort" },
        after: { name: "North" },
      });
    });

    it("allows changing only the capitals; same name is a no-op without audit", async () => {
      const s = await setup();
      const area = await add(s, "north");
      const caps = await renameArea.call(s.rt, s.owner, { areaId: area.id, name: "North" });
      expect(caps.ok && caps.value.name).toBe("North");
      const same = await renameArea.call(s.rt, s.owner, { areaId: area.id, name: " North " });
      expect(same.ok).toBe(true);
      expect(await auditFor(s, area.id)).toHaveLength(2); // create + one rename
    });

    it("refuses another area's name and an unknown id", async () => {
      const s = await setup();
      const north = await add(s, "North");
      await add(s, "South");
      const clash = await renameArea.call(s.rt, s.owner, { areaId: north.id, name: "south" });
      expect(!clash.ok && clash.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "name_taken" },
      });
      const missing = await renameArea.call(s.rt, s.owner, { areaId: uuidv7(), name: "X" });
      expect(!missing.ok && missing.error).toEqual({ code: "NOT_FOUND" });
    });
  });

  describe("areas.archive / areas.restore", () => {
    it("hides an area in use: its customers keep it; restoring brings it back", async () => {
      const s = await setup();
      const area = await add(s, "North");
      const customerId = await addCustomer(s, area.id);

      const hidden = await archiveArea.call(s.rt, s.owner, { areaId: area.id });
      expect(hidden.ok && hidden.value).toEqual({
        id: area.id,
        name: "North",
        archivedAt: NOW,
        customerCount: 1,
      });
      const [customer] = await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
        tx.select({ areaId: customers.areaId }).from(customers).where(eq(customers.id, customerId)),
      );
      expect(customer?.areaId).toBe(area.id);

      // Hiding twice changes nothing and writes no second event.
      expect((await archiveArea.call(s.rt, s.owner, { areaId: area.id })).ok).toBe(true);

      const shown = await restoreArea.call(s.rt, s.owner, { areaId: area.id });
      expect(shown.ok && shown.value.archivedAt).toBeNull();
      expect((await restoreArea.call(s.rt, s.owner, { areaId: area.id })).ok).toBe(true);

      const audit = await auditFor(s, area.id);
      expect(audit.map((a) => [a.action, a.before, a.after])).toEqual([
        ["areas.create", null, { name: "North" }],
        ["areas.archive", { archived: false }, { archived: true, customer_count: 1 }],
        ["areas.restore", { archived: true }, { archived: false }],
      ]);
    });

    it("has no delete: the row stays", async () => {
      const s = await setup();
      const area = await add(s, "North");
      await archiveArea.call(s.rt, s.owner, { areaId: area.id });
      const rows = await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
        tx.select({ id: areas.id }).from(areas).where(eq(areas.id, area.id)),
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("who may change areas", () => {
    it("Staff and linemen get FORBIDDEN for every change; nothing changes", async () => {
      const s = await setup();
      const area = await add(s, "North");
      const before = await databaseFingerprint(t.current);
      for (const ctx of [s.staff, s.lineman]) {
        const calls = [
          createArea.call(s.rt, ctx, { name: "South" }),
          renameArea.call(s.rt, ctx, { areaId: area.id, name: "South" }),
          archiveArea.call(s.rt, ctx, { areaId: area.id }),
          restoreArea.call(s.rt, ctx, { areaId: area.id }),
        ];
        for (const result of await Promise.all(calls)) {
          expect(!result.ok && result.error.code).toBe("FORBIDDEN");
        }
      }
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });

    it.each(["read_only", "cancelled", null] as const)(
      "a %s tenant's Owner gets TENANT_READ_ONLY for every change",
      async (status) => {
        const s = await setup(status);
        const areaId = uuidv7();
        await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
          tx.insert(areas).values({ id: areaId, operatorId: s.tenant.operatorId, name: "North" }),
        );
        const before = await databaseFingerprint(t.current);
        const results = [
          await createArea.call(s.rt, s.owner, { name: "South" }),
          await renameArea.call(s.rt, s.owner, { areaId, name: "South" }),
          await archiveArea.call(s.rt, s.owner, { areaId }),
          await restoreArea.call(s.rt, s.owner, { areaId }),
        ];
        for (const result of results) {
          expect(!result.ok && result.error.code).toBe("TENANT_READ_ONLY");
        }
        expect(await databaseFingerprint(t.current)).toEqual(before);
        // Reading still works (read-only mode allows every read).
        expect((await listAreas.call(s.rt, s.owner, {})).ok).toBe(true);
      },
    );
  });
});
