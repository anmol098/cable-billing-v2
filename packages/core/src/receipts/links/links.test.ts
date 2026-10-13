/**
 * Receipt preview links against a real database (T-050, FR-021, PLAN §9.4, D-14, RULE-22):
 * making and revoking links, opening them from the public side (expiry, revocation, rate limits,
 * no existence oracle, tenant separation, access counting, cancelled receipts, logs without
 * personal data) and the weekly purge job.
 */
import { auditEvents, customers, receiptLinks, receipts, type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter, type RateLimiter } from "../../auth/rate-limit";
import type { ServiceRuntime } from "../../context/runtime";
import type { TenantContext } from "../../context/tenant-context";
import { buildJobContext } from "../../jobs/context";
import { postPayment } from "../../payments/post-payment";
import { reversePayment } from "../../payments/reverse-payment";
import { issueInvoice } from "../../payments/test-support";
import {
  captureLogs,
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../../testing/fixtures";
import { createReceiptLink, RECEIPT_LINK_MAX_LIVE, revokeReceiptLinks } from "./manage";
import { type OpenReceiptLinkDeps, openReceiptLink } from "./public";
import { purgeExpiredReceiptLinksJob, RECEIPT_LINK_PURGE_AFTER_DAYS } from "./purge";
import { generateReceiptLinkToken, hashReceiptLinkToken, RECEIPT_LINK_TTL_MS } from "./token";
import { loadPublicReceipt } from "./view";

const NOW = new Date("2026-10-13T06:00:00.000Z");
const DAY = 86_400_000;
const IP = "203.0.113.7";

describeDb("receipt links", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime & { records: unknown[] };
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
  }

  async function setup(name?: string): Promise<Setup> {
    const tenant = await seedTenant(t.current, name ? { name } : {});
    const rt = testRuntime(t.current.db, { now: () => NOW });
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

  /** A customer with Sep and Oct bills of ₹300, paid ₹500 at the counter: Sep paid, Oct ₹100 left. */
  async function paidReceipt(s: Setup, options: { name?: string; phone?: string | null } = {}) {
    const customerId = uuidv7();
    await tenantTx(s, async (tx) => {
      await tx.insert(customers).values({
        id: customerId,
        operatorId: s.tenant.operatorId,
        customerCode: `C-${customerId.slice(-6)}`,
        name: options.name ?? "Shri Ramesh Kumar Verma",
        phone: options.phone === undefined ? "9876543210" : options.phone,
        address: "12 Gali No. 4",
      });
      await issueInvoice(tx, s.tenant.operatorId, customerId, {
        period: "2026-09-01",
        chargesPaise: 30_000,
      });
      await issueInvoice(tx, s.tenant.operatorId, customerId, {
        period: "2026-10-01",
        chargesPaise: 30_000,
      });
    });
    const posted = await postPayment.call(s.rt, s.owner, {
      id: uuidv7(),
      customerId,
      amountPaise: 50_000,
      method: "upi",
      upiReference: "412345678901",
      notes: "paid at the shop",
    });
    if (!posted.ok) throw new Error(`post: ${posted.error.code}`);
    return {
      customerId,
      paymentId: posted.value.payment.id,
      receiptNumber: posted.value.receipt.receiptNumber,
    };
  }

  async function makeLink(s: Setup, paymentId: string, ctx: TenantContext = s.owner) {
    const created = await createReceiptLink.call(s.rt, ctx, { paymentId });
    if (!created.ok) throw new Error(`link: ${created.error.code}`);
    return created.value;
  }

  function opener(overrides: Partial<OpenReceiptLinkDeps> = {}) {
    const logs = captureLogs();
    const deps: OpenReceiptLinkDeps = {
      db: t.current.db,
      limiter: createMemoryRateLimiter({ now: () => NOW.getTime() }),
      logger: logs.logger,
      now: () => NOW,
      ...overrides,
    };
    return {
      logs,
      open: (token: string, extra: { ip?: string; format?: "html" | "pdf"; at?: Date } = {}) =>
        openReceiptLink(
          { ...deps, ...(extra.at ? { now: () => extra.at as Date } : {}) },
          { token, clientIp: extra.ip ?? IP, format: extra.format ?? "html" },
        ),
    };
  }

  async function linkRow(id: string) {
    const rows = await t.current.admin.query("SELECT * FROM receipt_links WHERE id = $1", [id]);
    return rows.rows[0] as Record<string, unknown> | undefined;
  }

  describe("receipts.create_link", () => {
    it("makes a 90-day link and stores only the token's SHA-256", async () => {
      const s = await setup();
      const { paymentId, receiptNumber } = await paidReceipt(s);
      const link = await makeLink(s, paymentId);

      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(link.receiptNumber).toBe(receiptNumber);
      expect(link.expiresAt.getTime()).toBe(NOW.getTime() + RECEIPT_LINK_TTL_MS);
      const row = await linkRow(link.linkId);
      expect(row).toMatchObject({
        token_hash: hashReceiptLinkToken(link.token),
        created_by: s.tenant.users.owner,
        access_count: 0,
        revoked_at: null,
      });
      // The raw token is nowhere in the row, the audit trail or the logs.
      const everything = JSON.stringify([
        row,
        (
          await t.current.admin.query("SELECT * FROM audit_events WHERE operator_id = $1", [
            s.tenant.operatorId,
          ])
        ).rows,
        s.rt.records,
      ]);
      expect(everything).not.toContain(link.token);
      const [audit] = await tenantTx(s, (tx) =>
        tx.select().from(auditEvents).where(eq(auditEvents.entityId, link.linkId)),
      );
      expect(audit).toMatchObject({ action: "receipts.create_link", entityType: "receipt_link" });
    });

    it("makes a new token on every call (old ones keep working)", async () => {
      const s = await setup();
      const { paymentId } = await paidReceipt(s);
      const a = await makeLink(s, paymentId);
      const b = await makeLink(s, paymentId, s.lineman);
      expect(a.token).not.toBe(b.token);
      const { open } = opener();
      expect((await open(a.token)).kind).toBe("ok");
      expect((await open(b.token)).kind).toBe("ok");
    });

    it("works for every role and in read-only mode (D-13), NOT_FOUND for an unknown payment", async () => {
      const s = await setup();
      const { paymentId } = await paidReceipt(s);
      for (const ctx of [s.owner, s.staff, s.lineman]) {
        expect((await createReceiptLink.call(s.rt, ctx, { paymentId })).ok).toBe(true);
      }
      await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
      expect((await createReceiptLink.call(s.rt, s.lineman, { paymentId })).ok).toBe(true);
      const missing = await createReceiptLink.call(s.rt, s.owner, { paymentId: uuidv7() });
      expect(missing).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
      const bad = await createReceiptLink.call(s.rt, s.owner, { paymentId: "nope" });
      expect(bad.ok ? null : bad.error.code).toBe("VALIDATION");
    });

    it(`refuses more than ${RECEIPT_LINK_MAX_LIVE} live links per receipt`, async () => {
      const s = await setup();
      const { paymentId } = await paidReceipt(s);
      for (let i = 0; i < RECEIPT_LINK_MAX_LIVE; i += 1) await makeLink(s, paymentId);
      const over = await createReceiptLink.call(s.rt, s.owner, { paymentId });
      expect(over.ok ? null : over.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "too_many_links" },
      });
      // Revoking frees the slots.
      await revokeReceiptLinks.call(s.rt, s.owner, { paymentId });
      expect((await createReceiptLink.call(s.rt, s.owner, { paymentId })).ok).toBe(true);
    }, 60_000);
  });

  describe("openReceiptLink", () => {
    it("shows the receipt with first name and masked phone only, and counts the view", async () => {
      const s = await setup("Shree Ganesh Cable");
      await t.current.admin.query(
        `UPDATE operators SET phone = '01204567890',
           settings = settings || '{"office_phone": "9811122233", "receipt_footer": " Thank you ", "default_language": "en"}'::jsonb
         WHERE id = $1`,
        [s.tenant.operatorId],
      );
      const { paymentId, receiptNumber } = await paidReceipt(s);
      const link = await makeLink(s, paymentId);
      const { open, logs } = opener();

      const result = await open(link.token);
      expect(result).toEqual({
        kind: "ok",
        receipt: {
          operator: {
            name: "Shree Ganesh Cable",
            phone: "9811122233",
            footer: "Thank you",
            language: "en",
          },
          receiptNumber,
          provisionalRef: null,
          recordedAt: NOW,
          amountPaise: 50_000,
          method: "upi",
          customer: { firstName: "Ramesh", maskedPhone: "XXXXXX3210" },
          cancelled: false,
          bills: [
            { period: "2026-09-01", leftPaise: 0 },
            { period: "2026-10-01", leftPaise: 10_000 },
          ],
          balanceAfter: { kind: "due", paise: 10_000 },
        },
      });
      const text = JSON.stringify(result);
      for (const secret of ["Kumar", "Verma", "9876543210", "412345678901", "Gali", "C-", "shop"]) {
        expect(text).not.toContain(secret);
      }

      await open(link.token, { format: "pdf" });
      const row = await linkRow(link.linkId);
      expect(row).toMatchObject({ access_count: 2 });
      expect(row?.last_access_at).toEqual(NOW);
      const opened = logs.records.filter((r) => r.event === "receipt_link.opened");
      expect(opened).toHaveLength(2);
      expect(opened[1]).toMatchObject({ link_id: link.linkId, access_count: 2, format: "pdf" });
      // No token, hash or IP in any log line.
      const logText = JSON.stringify(logs.records);
      expect(logText).not.toContain(link.token);
      expect(logText).not.toContain(hashReceiptLinkToken(link.token));
      expect(logText).not.toContain(IP);
    });

    it("falls back to the operator phone, hides a missing customer phone, defaults to Hindi", async () => {
      const s = await setup();
      await t.current.admin.query("UPDATE operators SET phone = '01204567890' WHERE id = $1", [
        s.tenant.operatorId,
      ]);
      const { paymentId } = await paidReceipt(s, { name: "श्री रामप्रसाद शर्मा", phone: null });
      const link = await makeLink(s, paymentId);
      const result = await opener().open(link.token);
      if (result.kind !== "ok") throw new Error(result.kind);
      expect(result.receipt.operator).toMatchObject({
        phone: "01204567890",
        footer: null,
        language: "hi",
      });
      expect(result.receipt.customer).toEqual({ firstName: "रामप्रसाद", maskedPhone: null });
    });

    it("stops working at the expiry instant (90 days)", async () => {
      const s = await setup();
      const { paymentId } = await paidReceipt(s);
      const link = await makeLink(s, paymentId);
      const { open } = opener();
      const lastMs = new Date(link.expiresAt.getTime() - 1);
      expect((await open(link.token, { at: lastMs })).kind).toBe("ok");
      expect(await open(link.token, { at: link.expiresAt })).toEqual({ kind: "unavailable" });
      expect(await open(link.token, { at: new Date(NOW.getTime() + 365 * DAY) })).toEqual({
        kind: "unavailable",
      });
      expect(await linkRow(link.linkId)).toMatchObject({ access_count: 1 });
    });

    it("stops working once revoked, for good (all live links of the receipt)", async () => {
      const s = await setup();
      const { paymentId } = await paidReceipt(s);
      const a = await makeLink(s, paymentId);
      const b = await makeLink(s, paymentId);
      const { open } = opener();
      expect((await open(a.token)).kind).toBe("ok");

      const revoked = await revokeReceiptLinks.call(s.rt, s.staff, { paymentId });
      expect(revoked.ok && revoked.value.revoked).toBe(2);
      expect(await open(a.token)).toEqual({ kind: "unavailable" });
      expect(await open(b.token)).toEqual({ kind: "unavailable" });
      expect(await linkRow(a.linkId)).toMatchObject({
        revoked_by: s.tenant.users.staff,
        access_count: 1,
      });
      // Nothing left to revoke: ok, 0. Un-revoking is impossible (T-023 trigger).
      const again = await revokeReceiptLinks.call(s.rt, s.owner, { paymentId });
      expect(again.ok && again.value.revoked).toBe(0);
      await expect(
        t.current.admin.query("UPDATE receipt_links SET revoked_at = NULL WHERE id = $1", [
          a.linkId,
        ]),
      ).rejects.toThrow();
      // A new link after revocation works.
      expect((await open((await makeLink(s, paymentId)).token)).kind).toBe("ok");
    });

    it("gives the same answer for malformed, unknown, expired and revoked tokens (no existence leak)", async () => {
      const s = await setup();
      const { paymentId } = await paidReceipt(s);
      const expired = await makeLink(s, paymentId);
      const revoked = await makeLink(s, paymentId);
      await t.current.admin.query("UPDATE receipt_links SET revoked_at = $2 WHERE id = $1", [
        revoked.linkId,
        NOW,
      ]);
      const { open, logs } = opener();
      const later = new Date(expired.expiresAt.getTime() + 1);
      const answers = [
        await open("not-a-token"),
        await open(`${"A".repeat(42)}=`),
        await open(generateReceiptLinkToken().token),
        await open(expired.token, { at: later }),
        await open(revoked.token),
      ];
      for (const answer of answers) expect(answer).toStrictEqual({ kind: "unavailable" });
      // Nothing was counted for the dead links.
      expect(await linkRow(expired.linkId)).toMatchObject({ access_count: 0 });
      expect(await linkRow(revoked.linkId)).toMatchObject({ access_count: 0 });
      expect(logs.records.map((r) => r.reason)).toEqual([
        "malformed",
        "malformed",
        "unknown",
        "expired",
        "revoked",
      ]);
    });

    it("never crosses tenants: each token shows only its own tenant's receipt", async () => {
      const a = await setup("Tenant A Cable");
      const b = await setup("Tenant B Cable");
      const pa = await paidReceipt(a, { name: "Asha A" });
      const pb = await paidReceipt(b, { name: "Bina B" });
      const la = await makeLink(a, pa.paymentId);
      const lb = await makeLink(b, pb.paymentId);
      const { open } = opener();
      const ra = await open(la.token);
      const rb = await open(lb.token);
      if (ra.kind !== "ok" || rb.kind !== "ok") throw new Error("expected ok");
      expect(ra.receipt.operator.name).toBe("Tenant A Cable");
      expect(ra.receipt.customer.firstName).toBe("Asha");
      expect(ra.receipt.receiptNumber).toBe(pa.receiptNumber);
      expect(rb.receipt.operator.name).toBe("Tenant B Cable");
      expect(JSON.stringify(rb)).not.toContain("Asha");

      // Tenant B's transaction can't read tenant A's receipt, by B's id or by A's (RLS).
      const [receiptA] = await a.rt.db.withTenant(a.tenant.operatorId, (tx) =>
        tx.select({ id: receipts.id }).from(receipts).where(eq(receipts.paymentId, pa.paymentId)),
      );
      if (!receiptA) throw new Error("receipt A missing");
      await t.current.db.withTenant(b.tenant.operatorId, async (tx) => {
        expect(await loadPublicReceipt(tx, b.tenant.operatorId, receiptA.id)).toBeNull();
        expect(await loadPublicReceipt(tx, a.tenant.operatorId, receiptA.id)).toBeNull();
        expect(
          await tx.select().from(receiptLinks).where(eq(receiptLinks.id, la.linkId)),
        ).toHaveLength(0);
      });
      // Tenant B's users can't make or revoke links for A's payment.
      expect((await createReceiptLink.call(b.rt, b.owner, { paymentId: pa.paymentId })).ok).toBe(
        false,
      );
      const revoke = await revokeReceiptLinks.call(b.rt, b.owner, { paymentId: pa.paymentId });
      expect(revoke).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
      expect((await open(la.token)).kind).toBe("ok");
    });

    it("shows a reversed payment as cancelled, without bills or balance", async () => {
      const s = await setup();
      const { paymentId } = await paidReceipt(s);
      const link = await makeLink(s, paymentId);
      const reversed = await reversePayment.call(s.rt, s.owner, {
        paymentId,
        reason: "Entered twice",
      });
      expect(reversed.ok).toBe(true);
      const result = await opener().open(link.token);
      if (result.kind !== "ok") throw new Error(result.kind);
      expect(result.receipt).toMatchObject({
        cancelled: true,
        bills: [],
        balanceAfter: null,
        amountPaise: 50_000,
      });
    });

    describe("rate limits", () => {
      const limits = {
        perIp: { limit: 5, windowSeconds: 60 },
        perToken: { limit: 2, windowSeconds: 60 },
      };

      it("limits views per token, before the lookup, the same for every token", async () => {
        const s = await setup();
        const { paymentId } = await paidReceipt(s);
        const link = await makeLink(s, paymentId);
        let clock = NOW.getTime();
        const limiter = createMemoryRateLimiter({ now: () => clock });
        const { open, logs } = opener({ limiter, limits });

        expect((await open(link.token, { ip: "198.51.100.1" })).kind).toBe("ok");
        expect((await open(link.token, { ip: "198.51.100.2" })).kind).toBe("ok");
        const third = await open(link.token, { ip: "198.51.100.3" });
        expect(third).toEqual({ kind: "rate_limited", retryAfterSeconds: 60 });
        // An unknown token is limited the same way (no hint that the first one exists).
        const unknown = generateReceiptLinkToken().token;
        await open(unknown, { ip: "198.51.100.4" });
        await open(unknown, { ip: "198.51.100.5" });
        expect(await open(unknown, { ip: "198.51.100.6" })).toEqual(third);
        // The limited view was not counted.
        expect(await linkRow(link.linkId)).toMatchObject({ access_count: 2 });
        expect(logs.records.filter((r) => r.event === "receipt_link.rate_limited")).toHaveLength(2);

        clock += 61_000;
        expect((await open(link.token, { ip: "198.51.100.7" })).kind).toBe("ok");
      });

      it("limits views per IP across tokens", async () => {
        const s = await setup();
        const { paymentId } = await paidReceipt(s);
        const tokens = await Promise.all(
          Array.from({ length: 6 }, async () => (await makeLink(s, paymentId)).token),
        );
        const { open } = opener({ limits });
        for (const token of tokens.slice(0, 5)) expect((await open(token)).kind).toBe("ok");
        expect((await open(tokens[5] as string)).kind).toBe("rate_limited");
        expect((await open(tokens[5] as string, { ip: "198.51.100.9" })).kind).toBe("ok");
      });

      it("fails open (and logs) when the shared limiter is down", async () => {
        const s = await setup();
        const { paymentId } = await paidReceipt(s);
        const link = await makeLink(s, paymentId);
        const broken: RateLimiter = {
          kind: "upstash",
          hit: () => Promise.reject(new Error("Upstash rate limit call failed (HTTP 503)")),
        };
        const { open, logs } = opener({ limiter: broken });
        expect((await open(link.token)).kind).toBe("ok");
        expect(logs.records.some((r) => r.event === "receipt_link.rate_limit_failed")).toBe(true);
      });
    });
  });

  describe("purge job", () => {
    it("deletes links expired more than 30 days ago in every tenant, keeps receipts and newer links", async () => {
      const a = await setup();
      const b = await setup();
      const pa = await paidReceipt(a);
      const pb = await paidReceipt(b);
      const insertLink = async (s: Setup, paymentId: string, expiresAt: Date) =>
        tenantTx(s, async (tx) => {
          const [receipt] = await tx
            .select({ id: receipts.id })
            .from(receipts)
            .where(eq(receipts.paymentId, paymentId));
          const id = uuidv7();
          await tx.insert(receiptLinks).values({
            id,
            operatorId: s.tenant.operatorId,
            receiptId: receipt?.id as string,
            tokenHash: generateReceiptLinkToken().tokenHash,
            createdAt: new Date(expiresAt.getTime() - RECEIPT_LINK_TTL_MS),
            expiresAt,
          });
          return id;
        });
      const cutoffDays = RECEIPT_LINK_PURGE_AFTER_DAYS;
      const oldA = await insertLink(
        a,
        pa.paymentId,
        new Date(NOW.getTime() - (cutoffDays + 1) * DAY),
      );
      const oldB = await insertLink(
        b,
        pb.paymentId,
        new Date(NOW.getTime() - (cutoffDays + 5) * DAY),
      );
      const recent = await insertLink(
        a,
        pa.paymentId,
        new Date(NOW.getTime() - (cutoffDays - 1) * DAY),
      );
      const live = (await makeLink(a, pa.paymentId)).linkId;

      const logs = captureLogs();
      const ctx = buildJobContext({
        db: t.current.db,
        job: {
          id: uuidv7(),
          type: purgeExpiredReceiptLinksJob.type,
          operatorId: null,
          attempt: 1,
          maxAttempts: 3,
          createdAt: NOW,
        },
        payload: {},
        requestId: uuidv7(),
        log: logs.logger,
        clock: () => NOW,
        deadline: new Date(NOW.getTime() + 240_000),
        yieldReserveMs: 30_000,
      });
      expect(await purgeExpiredReceiptLinksJob.run(ctx)).toBeUndefined();

      expect(await linkRow(oldA)).toBeUndefined();
      expect(await linkRow(oldB)).toBeUndefined();
      expect(await linkRow(recent)).toBeDefined();
      expect(await linkRow(live)).toBeDefined();
      const receiptsLeft = await t.current.admin.query(
        "SELECT count(*)::int AS n FROM receipts WHERE operator_id = ANY($1)",
        [[a.tenant.operatorId, b.tenant.operatorId]],
      );
      expect(receiptsLeft.rows[0]).toEqual({ n: 2 });
      const audits = await t.current.admin.query(
        "SELECT operator_id, after FROM audit_events WHERE action = 'receipt_links.purged' ORDER BY operator_id",
      );
      expect(audits.rows).toHaveLength(2);
      expect(audits.rows.map((r) => r.after.count)).toEqual([1, 1]);
      expect(logs.records.at(-1)).toMatchObject({ event: "receipt_link.purged", deleted: 2 });

      // Idempotent: a second run finds nothing more.
      await purgeExpiredReceiptLinksJob.run(ctx);
      expect(await linkRow(recent)).toBeDefined();
    });
  });
});
