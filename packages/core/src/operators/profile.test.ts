/**
 * Business profile services against a real database (T-030): who may read and save, validation
 * (nothing written on a refusal), the audit event, read-only mode (D-13), unknown settings keys
 * kept, and the saved values reaching their readers (bill numbers T-044, lineman app T-028).
 */
import { auditEvents, operators, type SubscriptionStatus } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter } from "../auth/rate-limit";
import { invoicePrefixOf } from "../billing/customer";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { createMobileAuthService } from "../mobile-auth/mobile-auth";
import { databaseFingerprint } from "../testing/fingerprint";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import {
  getBusinessProfile,
  normalizeInvoicePrefix,
  normalizeOfficePhone,
  type UpdateBusinessProfileCommand,
  UpdateBusinessProfileInput,
  updateBusinessProfile,
} from "./profile";

const NOW = new Date("2026-10-13T06:00:00.000Z");

const FORM: UpdateBusinessProfileCommand = {
  name: "  Shree   Ram Cable  ",
  phone: "+91 98765-43210",
  address: "Shop 4, Station Road\r\nNagpur  ",
  receiptFooter: "Thank you!\r\n\r\n\r\nPay by the 10th.",
  invoicePrefix: " src ",
  defaultLanguage: "en",
  midMonthStartPolicy: "charge_full_month",
};

describe("profile input rules (pure)", () => {
  it("normalises phone, prefix and text the way the form is typed", () => {
    expect(normalizeOfficePhone(" (0712) 255-1234 ")).toBe("07122551234");
    expect(normalizeOfficePhone("+91 98765.43210")).toBe("+919876543210");
    expect(normalizeInvoicePrefix(" cb1 ")).toBe("CB1");
    const parsed = UpdateBusinessProfileInput.parse(FORM);
    expect(parsed).toEqual({
      name: "Shree Ram Cable",
      phone: "+919876543210",
      address: "Shop 4, Station Road\nNagpur",
      receiptFooter: "Thank you!\n\nPay by the 10th.",
      invoicePrefix: "SRC",
      defaultLanguage: "en",
      midMonthStartPolicy: "charge_full_month",
    });
    expect(
      UpdateBusinessProfileInput.parse({ ...FORM, phone: " ", address: "  ", receiptFooter: "" }),
    ).toMatchObject({ phone: null, address: null, receiptFooter: null });
  });

  it.each([
    ["name", { name: "   " }, "too_small"],
    ["name", { name: "x".repeat(121) }, "too_big"],
    ["name", { name: "Ram\u001b Cable" }, "custom"],
    ["phone", { phone: "98765abc" }, "invalid_format"],
    ["phone", { phone: "12345" }, "invalid_format"],
    ["phone", { phone: "+9".repeat(11) }, "too_big"],
    ["address", { address: "x".repeat(501) }, "too_big"],
    ["receiptFooter", { receiptFooter: "x".repeat(501) }, "too_big"],
    ["receiptFooter", { receiptFooter: "Thanks\u001b@" }, "custom"],
    ["invoicePrefix", { invoicePrefix: "" }, "too_small"],
    ["invoicePrefix", { invoicePrefix: "ABCDEFGHI" }, "too_big"],
    ["invoicePrefix", { invoicePrefix: "C-B" }, "invalid_format"],
    ["invoicePrefix", { invoicePrefix: "बिल" }, "invalid_format"],
    ["defaultLanguage", { defaultLanguage: "fr" }, "invalid_value"],
    ["midMonthStartPolicy", { midMonthStartPolicy: "prorate" }, "invalid_value"],
  ])("refuses a bad %s (%j → %s)", (path, change, code) => {
    const result = UpdateBusinessProfileInput.safeParse({ ...FORM, ...change });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: [path], code });
  });
});

describeDb("business profile services", () => {
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

  async function operatorRow(s: Setup) {
    const rows = await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx.select().from(operators).where(eq(operators.id, s.tenant.operatorId)),
    );
    return rows[0];
  }

  async function auditRows(s: Setup) {
    return t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.operatorId, s.tenant.operatorId),
            eq(auditEvents.action, "operators.update_profile"),
          ),
        ),
    );
  }

  describe("operators.get_profile", () => {
    it("gives a new tenant's defaults and lets the Owner edit", async () => {
      const s = await setup();
      const result = await getBusinessProfile.call(s.rt, s.owner, {});
      expect(result.ok && result.value).toMatchObject({
        id: s.tenant.operatorId,
        editable: true,
        readOnlyReason: null,
        profile: {
          name: s.tenant.name,
          phone: null,
          address: null,
          receiptFooter: null,
          invoicePrefix: "INV",
          defaultLanguage: "hi",
          midMonthStartPolicy: "start_next_month",
        },
      });
    });

    it("shows Staff the profile read-only, and refuses linemen", async () => {
      const s = await setup();
      const staff = await getBusinessProfile.call(s.rt, s.staff, {});
      expect(staff.ok && staff.value).toMatchObject({
        editable: false,
        readOnlyReason: "not_owner",
      });
      const lineman = await getBusinessProfile.call(s.rt, s.lineman, {});
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
    });

    it.each(["read_only", "cancelled", null] as const)(
      "is read-only for the Owner when the subscription is %s",
      async (status) => {
        const s = await setup(status);
        const result = await getBusinessProfile.call(s.rt, s.owner, {});
        expect(result.ok && result.value).toMatchObject({
          editable: false,
          readOnlyReason: "tenant_read_only",
        });
        const staff = await getBusinessProfile.call(s.rt, s.staff, {});
        expect(staff.ok && staff.value.readOnlyReason).toBe("not_owner");
      },
    );

    it("falls back to the business phone when no office phone is set (like receipts)", async () => {
      const s = await setup();
      await t.current.admin.query("UPDATE operators SET phone = '9811122233' WHERE id = $1", [
        s.tenant.operatorId,
      ]);
      const result = await getBusinessProfile.call(s.rt, s.owner, {});
      expect(result.ok && result.value.profile.phone).toBe("9811122233");
    });
  });

  describe("operators.update_profile", () => {
    it("saves every field, keeps phone columns equal and audits the change", async () => {
      const s = await setup();
      const result = await updateBusinessProfile.call(s.rt, s.owner, FORM);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(result.value.changed).toEqual([
        "name",
        "phone",
        "address",
        "receiptFooter",
        "invoicePrefix",
        "defaultLanguage",
        "midMonthStartPolicy",
      ]);
      expect(result.value.updatedAt).toEqual(NOW);

      const row = await operatorRow(s);
      expect(row).toMatchObject({
        name: "Shree Ram Cable",
        phone: "+919876543210",
        address: "Shop 4, Station Road\nNagpur",
        updatedAt: NOW,
      });
      expect(row?.settings).toEqual({
        office_phone: "+919876543210",
        receipt_footer: "Thank you!\n\nPay by the 10th.",
        invoice_prefix: "SRC",
        default_language: "en",
        mid_month_start_policy: "charge_full_month",
      });

      const audit = await auditRows(s);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: s.tenant.users.owner,
        actorRole: "owner",
        entityType: "operator",
        entityId: s.tenant.operatorId,
        requestId: s.owner.requestId,
        before: {
          name: s.tenant.name,
          office_phone: null,
          address: null,
          receipt_footer: null,
          invoice_prefix: "INV",
          default_language: "hi",
          mid_month_start_policy: "start_next_month",
        },
        after: {
          name: "Shree Ram Cable",
          office_phone: "+919876543210",
          address: "Shop 4, Station Road\nNagpur",
          receipt_footer: "Thank you!\n\nPay by the 10th.",
          invoice_prefix: "SRC",
          default_language: "en",
          mid_month_start_policy: "charge_full_month",
        },
      });

      const read = await getBusinessProfile.call(s.rt, s.staff, {});
      expect(read.ok && read.value.profile).toEqual(result.value.profile);
    });

    it("audits only the fields that changed, and clearing the phone clears both columns", async () => {
      const s = await setup();
      await updateBusinessProfile.call(s.rt, s.owner, FORM);
      const result = await updateBusinessProfile.call(s.rt, s.owner, {
        ...FORM,
        phone: "",
        invoicePrefix: "CB",
      });
      expect(result.ok && result.value.changed).toEqual(["phone", "invoicePrefix"]);
      const row = await operatorRow(s);
      expect(row?.phone).toBeNull();
      expect(row?.settings).toMatchObject({ office_phone: null, invoice_prefix: "CB" });
      const audit = await auditRows(s);
      expect(audit).toHaveLength(2);
      const last = audit.find((a) => (a.after as Record<string, unknown>).invoice_prefix === "CB");
      expect(last?.before).toEqual({ office_phone: "+919876543210", invoice_prefix: "SRC" });
      expect(last?.after).toEqual({ office_phone: null, invoice_prefix: "CB" });
    });

    it("writes nothing and no audit event when nothing changed", async () => {
      const s = await setup();
      const first = await updateBusinessProfile.call(s.rt, s.owner, FORM);
      if (!first.ok) throw new Error(first.error.code);
      const before = await databaseFingerprint(t.current);
      const later = testRuntime(t.current.db, { now: () => new Date(NOW.getTime() + 60_000) });
      const again = await updateBusinessProfile.call(later, s.owner, FORM);
      expect(again.ok && again.value).toMatchObject({ changed: [], updatedAt: NOW });
      expect(await databaseFingerprint(t.current)).toEqual(before);
      expect(await auditRows(s)).toHaveLength(1);
    });

    it("keeps settings keys it does not know (added by later features)", async () => {
      const s = await setup();
      await t.current.admin.query(
        `UPDATE operators SET settings = settings || '{"future_flag": true}'::jsonb WHERE id = $1`,
        [s.tenant.operatorId],
      );
      const result = await updateBusinessProfile.call(s.rt, s.owner, FORM);
      expect(result.ok).toBe(true);
      expect((await operatorRow(s))?.settings).toMatchObject({
        future_flag: true,
        invoice_prefix: "SRC",
      });
    });

    it("refuses bad input with field paths (never values) and writes nothing", async () => {
      const s = await setup();
      const before = await databaseFingerprint(t.current);
      const result = await updateBusinessProfile.call(s.rt, s.owner, {
        ...FORM,
        phone: "call me",
        invoicePrefix: "C-B",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.details?.fields).toEqual([
        { path: "phone", code: "invalid_format" },
        { path: "invoicePrefix", code: "invalid_format" },
      ]);
      expect(JSON.stringify(result.error)).not.toContain("call me");
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });

    it("is Owner only: Staff and linemen get FORBIDDEN and nothing changes", async () => {
      const s = await setup();
      const before = await databaseFingerprint(t.current);
      for (const ctx of [s.staff, s.lineman]) {
        const result = await updateBusinessProfile.call(s.rt, ctx, FORM);
        expect(!result.ok && result.error.code).toBe("FORBIDDEN");
      }
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });

    it.each(["read_only", "cancelled", null] as const)(
      "refuses the Owner with TENANT_READ_ONLY when the subscription is %s",
      async (status) => {
        const s = await setup(status);
        const before = await databaseFingerprint(t.current);
        const result = await updateBusinessProfile.call(s.rt, s.owner, FORM);
        expect(!result.ok && result.error.code).toBe("TENANT_READ_ONLY");
        expect(await databaseFingerprint(t.current)).toEqual(before);
      },
    );

    it("saves again once the subscription is paid (grace/trialing are writable)", async () => {
      const s = await setup("read_only");
      await setSubscriptionStatus(t.current, s.tenant.operatorId, "grace");
      expect((await updateBusinessProfile.call(s.rt, s.owner, FORM)).ok).toBe(true);
    });

    it("reaches the bill numbers (T-044) and the lineman app (T-028) at once", async () => {
      const s = await setup();
      const result = await updateBusinessProfile.call(s.rt, s.owner, FORM);
      expect(result.ok).toBe(true);

      const prefix = await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
        invoicePrefixOf(tx, s.tenant.operatorId),
      );
      expect(prefix).toBe("SRC");

      const mobile = createMobileAuthService({
        runtime: s.rt,
        secret: "t030-test-secret-not-for-production-0123456789abcdef",
        rateLimiter: createMemoryRateLimiter({ now: () => NOW.getTime() }),
      });
      const config = await mobile.appConfig(s.lineman);
      expect(config.operator).toEqual({
        id: s.tenant.operatorId,
        name: "Shree Ram Cable",
        officePhone: "+919876543210",
        receiptFooter: "Thank you!\n\nPay by the 10th.",
      });
    });
  });
});
