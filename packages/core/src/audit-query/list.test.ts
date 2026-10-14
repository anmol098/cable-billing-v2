/**
 * "Who changed what" against a real database (T-035): Owner only (Staff and linemen refused by
 * the service), events written by real services come back with who / entity name / sentence
 * values and masked changes, every filter (IST days, person, the app itself, kind, action, one
 * thing), keyset pages that never repeat or skip an event while new events arrive, and the
 * viewer's own redaction of rows a writer did not redact.
 */
import { areas, auditEvents, customers, plans, type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it } from "vitest";
import { writeAuditEvent } from "../audit/audit";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { createCustomer, updateCustomerPhone } from "../customers/customers";
import { postPaymentInTx } from "../payments/post-payment";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import { decodeAuditCursor, encodeAuditCursor } from "./cursor";
import { type AuditEventView, listAuditEvents } from "./list";

describeDb("audit viewer (T-035)", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
  }

  async function setup(): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(t.current.db);
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

  /** Inserts an event at a chosen time (the writer always uses now()). */
  async function eventAt(
    s: Setup,
    at: string,
    overrides: Partial<typeof auditEvents.$inferInsert> = {},
  ): Promise<string> {
    const id = uuidv7();
    await tenantTx(s, (tx) =>
      tx.insert(auditEvents).values({
        id,
        operatorId: s.tenant.operatorId,
        actorId: s.tenant.users.owner,
        actorRole: "owner",
        action: "areas.create",
        entityType: "area",
        entityId: uuidv7(),
        after: { name: "North" },
        at: new Date(at),
        ...overrides,
      }),
    );
    return id;
  }

  async function list(s: Setup, input: Parameters<typeof listAuditEvents.call>[2] = {}) {
    const result = await listAuditEvents.call(s.rt, s.owner, input);
    if (!result.ok) throw new Error(`audit.list: ${result.error.code}`);
    return result.value;
  }

  it("is Owner only: Staff and linemen are refused by the service", async () => {
    const s = await setup();
    await eventAt(s, "2026-10-13T06:00:00Z");
    for (const ctx of [s.staff, s.lineman]) {
      const result = await listAuditEvents.call(s.rt, ctx, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    }
    expect((await list(s)).events).toHaveLength(1);
  });

  it("works in read-only mode (viewing is allowed)", async () => {
    const s = await setup();
    await eventAt(s, "2026-10-13T06:00:00Z");
    await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
    expect((await list(s)).events).toHaveLength(1);
  });

  it("shows a real phone change as who + customer code + masked numbers, never the full phones", async () => {
    const s = await setup();
    const created = await createCustomer.call(s.rt, s.owner, {
      customerCode: "1045",
      name: "Sita Devi",
      phone: "9876543210",
    });
    if (!created.ok) throw new Error(created.error.code);
    const customerId = created.value.customer.id;
    const changed = await updateCustomerPhone.call(s.rt, s.staff, {
      customerId,
      phone: "9123456780",
    });
    if (!changed.ok) throw new Error(changed.error.code);

    const page = await list(s);
    expect(page.events.map((e) => e.action)).toEqual([
      "customers.update_phone",
      "customers.create",
    ]);
    const [phone, create] = page.events as [AuditEventView, AuditEventView];
    expect(phone).toMatchObject({
      known: true,
      entityType: "customer",
      knownEntityType: true,
      actor: { kind: "person", id: s.tenant.users.staff, role: "staff" },
      target: { kind: "text", value: "1045" },
      details: { field: { kind: "code", value: "phone" } },
      changes: [
        {
          field: "phone",
          before: { kind: "text", value: "XXXXXX3210" },
          after: { kind: "text", value: "XXXXXX6780" },
        },
      ],
    });
    expect(phone.actor.kind === "person" && phone.actor.name).toBeTruthy();
    expect(create.changes.find((c) => c.field === "name")?.after).toEqual({
      kind: "text",
      value: "Sita Devi",
    });
    const json = JSON.stringify(page);
    expect(json).not.toContain("9876543210");
    expect(json).not.toContain("9123456780");
    // The actors list offers every person of the business for the "Who" filter.
    expect(page.actors.map((a) => a.id).sort()).toEqual(Object.values(s.tenant.users).sort());
  });

  it("names payments by receipt number and customer, and things that are gone by nothing", async () => {
    const s = await setup();
    const customerId = uuidv7();
    const areaId = uuidv7();
    const planId = uuidv7();
    const { payment, receipt } = await tenantTx(s, async (tx) => {
      await tx.insert(customers).values({
        id: customerId,
        operatorId: s.tenant.operatorId,
        customerCode: "C-77",
        name: "Ravi",
      });
      await tx
        .insert(areas)
        .values({ id: areaId, operatorId: s.tenant.operatorId, name: "Gandhi Nagar" });
      await tx.insert(plans).values({
        id: planId,
        operatorId: s.tenant.operatorId,
        name: "Gold 300",
        monthlyAmountPaise: 30_000,
      });
      const posted = await postPaymentInTx(
        tx,
        {
          operatorId: s.tenant.operatorId,
          userId: s.tenant.users.owner,
          channel: "web",
          deviceId: null,
        },
        { id: uuidv7(), customerId, amountPaise: 25_000, method: "upi" },
        new Date(),
      );
      if (!posted.ok) throw new Error(posted.error.code);
      return posted.value;
    });
    await eventAt(s, "2026-10-13T06:00:00Z", {
      action: "payments.post",
      entityType: "payment",
      entityId: payment.id,
      after: { amount_paise: 25_000, method: "upi", customer_id: customerId },
    });
    await eventAt(s, "2026-10-13T06:00:01Z", { entityId: areaId });
    await eventAt(s, "2026-10-13T06:00:02Z", {
      action: "team.deactivate",
      entityType: "user",
      entityId: s.tenant.users.lineman,
      before: { status: "active" },
      after: { status: "disabled", role: "lineman" },
    });
    await eventAt(s, "2026-10-13T06:00:03Z", {
      action: "receipt_links.purged",
      entityType: "receipt_link",
      entityId: null,
      actorId: null,
      actorRole: null,
      after: { count: 3 },
    });
    await eventAt(s, "2026-10-13T06:00:04Z", {
      action: "receipts.create_link",
      entityType: "receipt_link",
      entityId: uuidv7(), // purged since
    });
    await eventAt(s, "2026-10-13T06:00:05Z", {
      action: "plans.update",
      entityType: "plan",
      entityId: planId,
      before: { monthly_amount_paise: 25_000 },
      after: { monthly_amount_paise: 30_000, connection_count: 4 },
    });

    const [plan, gone, purged, deactivated, area, posted] = (await list(s))
      .events as AuditEventView[];
    expect(plan).toMatchObject({
      target: { kind: "text", value: "Gold 300" },
      details: { fields: { kind: "fields", value: ["monthly_amount_paise"] } },
    });
    expect(posted).toMatchObject({
      target: { kind: "text", value: receipt.receiptNumber },
      details: {
        customer: { kind: "text", value: "C-77" },
        amount: { kind: "paise", value: 25_000 },
        method: { kind: "code", value: "upi" },
      },
    });
    // The customer id is internal: the change list leaves it out.
    // (jsonb keeps its own key order.)
    expect(posted?.changes.map((c) => c.field).sort()).toEqual(["amount_paise", "method"]);
    expect(area?.target).toEqual({ kind: "text", value: "Gandhi Nagar" });
    expect(deactivated?.target?.kind).toBe("text");
    expect(purged).toMatchObject({
      actor: { kind: "system" },
      target: null,
      details: { count: { kind: "count", value: 3 } },
    });
    expect(gone?.target).toBeNull();
  });

  it("filters by IST days, person, the app itself, kind, action and one thing", async () => {
    const s = await setup();
    const customerId = uuidv7();
    // 13 Oct 23:59 IST and 14 Oct 00:00 IST.
    const lateOn13 = await eventAt(s, "2026-10-13T18:29:59.999Z", {
      actorId: s.tenant.users.staff,
      actorRole: "staff",
      action: "customers.update_phone",
      entityType: "customer",
      entityId: customerId,
    });
    const startOf14 = await eventAt(s, "2026-10-13T18:30:00.000Z", {
      action: "customers.update",
      entityType: "customer",
      entityId: customerId,
    });
    const system = await eventAt(s, "2026-10-14T03:00:00Z", {
      actorId: null,
      actorRole: null,
      action: "billing.run_scheduled",
      entityType: "billing_run",
    });
    const lineman = await eventAt(s, "2026-10-15T03:00:00Z", {
      actorId: s.tenant.users.lineman,
      actorRole: "lineman",
      action: "auth.signed_in",
      entityType: "user",
      entityId: s.tenant.users.lineman,
    });
    const ids = async (input: Parameters<typeof list>[1]) =>
      (await list(s, input)).events.map((e) => e.id);

    expect(await ids({})).toEqual([lineman, system, startOf14, lateOn13]);
    expect(await ids({ from: "2026-10-13", to: "2026-10-13" })).toEqual([lateOn13]);
    expect(await ids({ from: "2026-10-14", to: "2026-10-14" })).toEqual([system, startOf14]);
    expect(await ids({ from: "2026-10-14" })).toEqual([lineman, system, startOf14]);
    expect(await ids({ to: "2026-10-13" })).toEqual([lateOn13]);
    expect(await ids({ actor: s.tenant.users.staff })).toEqual([lateOn13]);
    expect(await ids({ actor: s.tenant.users.lineman })).toEqual([lineman]);
    expect(await ids({ actor: "system" })).toEqual([system]);
    expect(await ids({ entityType: "customer" })).toEqual([startOf14, lateOn13]);
    expect(await ids({ action: "customers.update" })).toEqual([startOf14]);
    expect(await ids({ entityType: "customer", entityId: customerId })).toEqual([
      startOf14,
      lateOn13,
    ]);
    expect(
      await ids({ entityType: "customer", actor: s.tenant.users.owner, from: "2026-10-14" }),
    ).toEqual([startOf14]);
    expect(await ids({ action: "payments.reverse" })).toEqual([]);
  });

  it("refuses another tenant's person, a made-up person, a bad cursor and backwards dates", async () => {
    const s = await setup();
    const other = await seedTenant(t.current);
    for (const actor of [other.users.owner, uuidv7()]) {
      const result = await listAuditEvents.call(s.rt, s.owner, { actor });
      expect(result.ok ? "ok" : result.error.code).toBe("NOT_FOUND");
    }
    for (const input of [
      { cursor: "not a cursor" },
      { cursor: Buffer.from("2026-10-13|x").toString("base64url") },
      { from: "2026-10-14", to: "2026-10-13" },
      { action: "Customers Update" },
      { entityType: "Customer" },
      { entityId: uuidv7() },
    ]) {
      const result = await listAuditEvents.call(s.rt, s.owner, input);
      expect(result.ok ? "ok" : result.error.code, JSON.stringify(input)).toBe("VALIDATION");
    }
  });

  it("keyset pages never repeat or skip an event, also while new events arrive", async () => {
    const s = await setup();
    // 230 older events: groups share one `at` (one transaction's now()), others differ only in
    // microseconds within one millisecond (a JS Date can't tell them apart).
    await t.current.admin.query(
      `INSERT INTO audit_events (id, operator_id, actor_id, actor_role, action, entity_type, at)
       SELECT gen_random_uuid(), $1, $2, 'owner', 'areas.create', 'area',
              timestamptz '2026-09-01 10:00:00+00' + ((g / 7) * interval '1 second')
                + ((g % 3) * interval '1 microsecond')
       FROM generate_series(1, 230) AS g`,
      [s.tenant.operatorId, s.tenant.users.owner],
    );
    const expected = (
      await t.current.admin.query<{ id: string }>(
        "SELECT id FROM audit_events WHERE operator_id = $1 ORDER BY at DESC, id DESC",
        [s.tenant.operatorId],
      )
    ).rows.map((r) => r.id);
    expect(expected).toHaveLength(230);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      // New events land while the Owner pages (concurrently with the read).
      const [page] = await Promise.all([
        list(s, { limit: 50, ...(cursor ? { cursor } : {}) }),
        tenantTx(s, (tx) =>
          writeAuditEvent(tx, {
            operatorId: s.tenant.operatorId,
            actorId: s.tenant.users.staff,
            actorRole: "staff",
            action: "areas.rename",
            entityType: "area",
            entityId: uuidv7(),
          }),
        ),
      ]);
      pages += 1;
      // The first page may include the first new event if it committed first; skip new ones.
      seen.push(...page.events.filter((e) => e.action === "areas.create").map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages < 20);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
    expect(pages).toBe(5);
  }, 60_000);

  it("the cursor keeps microseconds and round-trips", () => {
    const cursor = {
      at: "2026-10-14T06:30:49.438123Z",
      id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    expect(decodeAuditCursor("")).toBeNull();
    expect(decodeAuditCursor(Buffer.from("x|y|z").toString("base64url"))).toBeNull();
  });

  it("hides secrets and masks contacts in rows a writer did not redact", async () => {
    const s = await setup();
    await eventAt(s, "2026-10-13T06:00:00Z", {
      action: "some_future.action",
      entityType: "widget",
      entityId: null,
      before: {
        password: "hunter2-secret",
        refreshToken: "tok-abcdef",
        ip: "203.0.113.9",
        userAgent: "Mozilla/5.0 secret-agent",
        email: "ramesh@example.com",
      },
      after: {
        note: "Call him on 98765 43210 or mail ramesh@example.com",
        login: "9812345678",
        officePhone: "+91 99887 76655",
        kyc: { aadhaar: "1234 5678 9012" },
      },
    });
    const [event] = (await list(s)).events as AuditEventView[];
    expect(event).toMatchObject({ known: false, knownEntityType: false, details: {} });
    const byField = Object.fromEntries((event?.changes ?? []).map((c) => [c.field, c]));
    expect(byField.password?.before).toEqual({ kind: "hidden" });
    expect(byField.refresh_token?.before).toEqual({ kind: "hidden" });
    expect(byField.ip?.before).toEqual({ kind: "hidden" });
    expect(byField.user_agent?.before).toEqual({ kind: "hidden" });
    expect(byField.email?.before).toEqual({ kind: "text", value: "r•••@example.com" });
    expect(byField.login?.after).toEqual({ kind: "text", value: "XXXXXX5678" });
    expect(byField.office_phone?.after).toEqual({ kind: "text", value: "XXXXXX6655" });
    expect(byField.kyc?.after).toEqual({ kind: "hidden" });
    const json = JSON.stringify(event);
    for (const secret of [
      "hunter2",
      "tok-abcdef",
      "203.0.113.9",
      "Mozilla",
      "ramesh@",
      "98765 43210",
      "9812345678",
      "99887",
      "1234 5678",
    ]) {
      expect(json, secret).not.toContain(secret);
    }
  });
});
