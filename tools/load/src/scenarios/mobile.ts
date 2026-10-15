/**
 * Lineman phones (PLAN §10, the T-060/T-061 endpoints):
 *
 * - `sync`: the morning burst. Every phone opens the app in the same moment: app config, a full
 *   roster sync (pages of 500), then rounds of "open a customer" + delta sync.
 * - `payments`: the evening burst. Every phone pushes full batches of 50 payments at once
 *   (`POST /payments:batch`), replays one batch as a phone whose answer got lost would (every item
 *   must come back `duplicate`), pushes its receipt actions, reads its day totals and pulls a delta.
 *
 * Payments are real postings on the target (small whole-rupee amounts, active customers only):
 * run this against a seeded staging/preview database, never production.
 */
import {
  MOBILE_API_BASE_PATH,
  PAYMENT_BATCH_MAX,
  type PaymentBatchItem,
  type PaymentBatchResponse,
  type ReceiptActionItem,
  ROSTER_PAGE_MAX,
  type SyncCustomersResponse,
} from "@cb/contracts";
import type { MobileSession } from "../auth";
import { everyone, pick, type RosterEntry, type RunContext, signInAll } from "../context";
import { jsonOf } from "../http";
import { istDate, provisionalRefs, uuidv7 } from "../ids";
import { spread } from "../personas";

const API = MOBILE_API_BASE_PATH;

interface Phone {
  readonly operator: number;
  readonly login: string;
  readonly session: MobileSession;
}

/** The phones of this run: `profile.linemen` linemen, round-robin across operators. */
export function plannedLinemen(ctx: Pick<RunContext, "personas" | "profile">): string[] {
  return spread(
    ctx.personas.map((operator) => operator.linemen),
    ctx.profile.linemen,
  );
}

function operatorOf(login: string): number {
  return Number(/^seed-op(\d+)-/.exec(login)?.[1] ?? 0);
}

async function phones(ctx: RunContext): Promise<Phone[]> {
  const ready = await signInAll(
    plannedLinemen(ctx),
    (login) => ctx.mobile(login),
    ctx.log,
    "phone",
  );
  return ready.map(({ login, session }) => ({ operator: operatorOf(login), login, session }));
}

/** A full roster pass; keeps the roster for the operator and the phone's cursor. */
async function fullSync(ctx: RunContext, phone: Phone, metricPrefix: string): Promise<void> {
  await phone.session.ensureFresh();
  const started = performance.now();
  let bytes = 0;
  let ok = true;
  let cursor: string | undefined;
  const roster: RosterEntry[] = [];
  for (let page = 0; page < 1000; page += 1) {
    const query = new URLSearchParams({ limit: String(ROSTER_PAGE_MAX) });
    if (cursor) query.set("cursor", cursor);
    const answer = await phone.session.http.request(`${API}/sync/customers?${query}`, {
      metric: `${metricPrefix}.page`,
    });
    bytes += answer.bytes;
    const body = answer.ok ? jsonOf<SyncCustomersResponse>(answer) : undefined;
    if (!body) {
      ok = false;
      break;
    }
    for (const row of body.customers) {
      roster.push({ id: row.id, active: row.active, balancePaise: row.balance_paise });
    }
    cursor = body.next_cursor;
    if (!body.has_more) break;
  }
  ctx.recorder.record(`${metricPrefix}.full`, { ms: performance.now() - started, ok, bytes });
  if (cursor) ctx.cursors.set(phone.login, cursor);
  if (ok && !ctx.rosters.has(phone.operator)) ctx.rosters.set(phone.operator, roster);
}

async function deltaSync(ctx: RunContext, phone: Phone): Promise<void> {
  const cursor = ctx.cursors.get(phone.login);
  if (!cursor) return;
  await phone.session.ensureFresh();
  const query = new URLSearchParams({ limit: String(ROSTER_PAGE_MAX), cursor });
  const answer = await phone.session.http.request(`${API}/sync/customers?${query}`, {
    metric: "mobile.sync.delta",
  });
  const body = answer.ok ? jsonOf<SyncCustomersResponse>(answer) : undefined;
  if (body) ctx.cursors.set(phone.login, body.next_cursor);
}

export async function runSync(ctx: RunContext): Promise<void> {
  const all = await phones(ctx);
  ctx.log(`  ${all.length} phones signed in; morning burst starts`);
  await everyone(ctx, all, "phone", async (phone) => {
    await phone.session.ensureFresh();
    await phone.session.http.request(`${API}/app/config`, { metric: "mobile.config" });
    await fullSync(ctx, phone, "mobile.sync");
    const roster = ctx.rosters.get(phone.operator) ?? [];
    for (let round = 0; round < ctx.profile.syncRounds; round += 1) {
      const customer = pick(roster);
      if (customer) {
        await phone.session.http.request(`${API}/customers/${customer.id}`, {
          metric: "mobile.customer.detail",
        });
      }
      await deltaSync(ctx, phone);
    }
  });
}

/** A batch item as sent on the wire (the contract's `Paise` brand is a plain integer in JSON). */
type WirePayment = Omit<PaymentBatchItem, "amount_paise"> & { amount_paise: number };

function paymentFor(
  phone: Phone,
  customer: RosterEntry,
  nextRef: () => string,
  now: number,
): WirePayment {
  const upi = Math.random() < 0.2;
  // ₹100–₹500 in whole rupees; saved on the phone in the last few hours, never in the future.
  const rupees = 100 + 50 * Math.floor(Math.random() * 9);
  return {
    id: uuidv7(now),
    customer_id: customer.id,
    amount_paise: rupees * 100,
    method: upi ? "upi" : "cash",
    upi_reference: upi
      ? String(400_000_000_000 + Math.floor(Math.random() * 99_999_999_999))
      : null,
    notes: null,
    recorded_at: new Date(now - Math.floor(Math.random() * 3 * 60 * 60_000)).toISOString(),
    provisional_ref: nextRef(),
    collector_id: phone.session.userId,
    device_id: phone.session.deviceId,
  };
}

function countOutcomes(
  ctx: RunContext,
  body: PaymentBatchResponse | undefined,
  sent: number,
): void {
  if (!body) return;
  for (const result of body.results) ctx.recorder.count(`mobile.payments.${result.outcome}`);
  if (body.results.length !== sent) ctx.recorder.count("mobile.payments.missing_results");
}

export async function runPayments(ctx: RunContext): Promise<void> {
  const all = await phones(ctx);
  // A phone without a roster yet (sync not run in this process) pulls one first, as setup.
  for (const phone of all) {
    if (!ctx.rosters.has(phone.operator)) await fullSync(ctx, phone, "setup.roster");
  }
  ctx.log(`  ${all.length} phones ready; evening push starts`);
  const perBatch = Math.min(PAYMENT_BATCH_MAX, ctx.profile.paymentsPerBatch);
  await everyone(ctx, all, "phone", async (phone) => {
    const active = (ctx.rosters.get(phone.operator) ?? []).filter((c) => c.active);
    if (active.length === 0) throw new Error(`no active customers for operator ${phone.operator}`);
    const nextRef = provisionalRefs(phone.session.deviceCode, ctx.startedMs);
    const posted: string[] = [];
    let firstBatch: WirePayment[] | undefined;
    for (let batch = 0; batch < ctx.profile.paymentBatches; batch += 1) {
      await phone.session.ensureFresh();
      const now = Date.now();
      const items = Array.from({ length: perBatch }, () =>
        paymentFor(phone, pick(active) as RosterEntry, nextRef, now),
      );
      firstBatch ??= items;
      const answer = await phone.session.http.request(`${API}/payments:batch`, {
        method: "POST",
        body: JSON.stringify({ payments: items }),
        metric: "mobile.payments.batch",
        timeoutMs: 90_000,
      });
      const body = answer.ok ? jsonOf<PaymentBatchResponse>(answer) : undefined;
      countOutcomes(ctx, body, items.length);
      for (const result of body?.results ?? []) {
        if (result.outcome === "posted" || result.outcome === "posted_needs_review") {
          posted.push(result.id);
        }
      }
    }
    // The answer to the first batch was "lost": the phone sends it again.
    if (firstBatch) {
      const replay = await phone.session.http.request(`${API}/payments:batch`, {
        method: "POST",
        body: JSON.stringify({ payments: firstBatch }),
        metric: "mobile.payments.replay",
        timeoutMs: 90_000,
      });
      const body = replay.ok ? jsonOf<PaymentBatchResponse>(replay) : undefined;
      const notDuplicate = (body?.results ?? []).filter((r) => r.outcome !== "duplicate").length;
      if (notDuplicate > 0)
        ctx.recorder.count("mobile.payments.replay_not_duplicate", notDuplicate);
    }
    if (posted.length > 0) {
      const at = new Date().toISOString();
      const actions: ReceiptActionItem[] = posted.slice(0, 100).map((paymentId) => ({
        id: uuidv7(),
        payment_id: paymentId,
        action: "printed",
        at,
      }));
      await phone.session.http.request(`${API}/receipts/actions:batch`, {
        method: "POST",
        body: JSON.stringify({ actions }),
        metric: "mobile.receipts.actions",
      });
    }
    await phone.session.http.request(`${API}/collections/${istDate(new Date())}`, {
      metric: "mobile.collections.day",
    });
    await deltaSync(ctx, phone);
  });
}
