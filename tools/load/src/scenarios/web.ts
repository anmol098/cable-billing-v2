/**
 * Office users in the browser (Owners and Staff):
 *
 * - `counter`: counter payments (T-048). The clerk opens `/payments/new`, types in "Find customer"
 *   (the page's `findCustomers` Server Action), picks an active customer and saves the payment
 *   (`takePayment`), exactly the calls the page's JavaScript makes.
 * - `reports`: lists, search and reports (PRD §11 "common list/search operations"): every page is
 *   a full server render, timed to its last byte.
 * - `exports`: CSV downloads (T-082), within the 30-files-per-person-per-15-minutes limit.
 */
import { errorText, everyone, pick, pool, type RunContext, signInAll } from "../context";
import { reasonOf, type Session } from "../http";
import { istDate, uuidv7 } from "../ids";
import { actionHeaders, actionIdForProp, actionResult, NextProtocolError } from "../next";
import { spread } from "../personas";

/** What clerks type: name parts, code and phone prefixes, Hindi (the seed's word lists). */
export const SEARCH_TERMS: Readonly<Record<string, readonly string[]>> = {
  name: ["ram", "sunita", "kumar", "devi", "singh", "ramsh", "geeta", "mohan"],
  code: ["1", "12", "45", "1045", "7"],
  phone: ["5551", "55523", "5559"],
  hindi: ["राम", "देवी", "कुमार"],
};

/** The server's limit is 30 files per person per 15 minutes (`EXPORT_RATE_LIMIT`). */
export const MAX_EXPORTS_PER_OWNER = 25;

/** Counter clerks: each operator's first Staff, round-robin. */
export function plannedCounterUsers(ctx: Pick<RunContext, "personas" | "profile">): string[] {
  return spread(
    ctx.personas.map((operator) => operator.staff.slice(0, 1)),
    ctx.profile.counterUsers,
  );
}

/** Report readers: Owners and Staff, alternating, across operators. */
export function plannedWebUsers(ctx: Pick<RunContext, "personas" | "profile">): string[] {
  return spread(
    ctx.personas.map((operator) => [operator.owner, ...operator.staff]),
    ctx.profile.webUsers,
  );
}

export function plannedExportOwners(ctx: Pick<RunContext, "personas" | "profile">): string[] {
  return spread(
    ctx.personas.map((operator) => [operator.owner]),
    ctx.profile.exportOwners,
  );
}

interface FoundCustomer {
  readonly id: string;
  readonly active: boolean;
}
type FindResult = { ok: true; customers: FoundCustomer[] } | { ok: false };
type TakeResult = { ok: true; payment: { paymentId: string } } | { ok: false; error: string };

async function callAction<T>(
  session: Session,
  path: string,
  actionId: string,
  args: unknown[],
  metric: string,
): Promise<T | undefined> {
  const answer = await session.request(path, {
    method: "POST",
    headers: actionHeaders(new URL(session.baseUrl).origin, actionId),
    body: JSON.stringify(args),
    metric,
  });
  return answer.ok ? actionResult<T>(answer.text) : undefined;
}

export async function runCounter(ctx: RunContext): Promise<void> {
  const clerks = await signInAll(plannedCounterUsers(ctx), (l) => ctx.web(l), ctx.log, "clerk");
  ctx.log(`  ${clerks.length} counter clerks signed in`);
  const terms = [...(SEARCH_TERMS.name ?? []), ...(SEARCH_TERMS.code ?? [])];
  await everyone(ctx, clerks, "clerk", async ({ session }) => {
    const page = await session.request("/payments/new", { metric: "counter.page" });
    if (page.status !== 200) throw new Error(`/payments/new answered ${reasonOf(page)}`);
    let findId: string;
    let takeId: string;
    try {
      findId = actionIdForProp(page.text, "findCustomers");
      takeId = actionIdForProp(page.text, "takePayment");
    } catch (error) {
      if (error instanceof NextProtocolError) ctx.recorder.count("counter.protocol_error");
      throw error;
    }
    for (let i = 0; i < ctx.profile.counterPayments; i += 1) {
      let customer: FoundCustomer | undefined;
      for (let attempt = 0; attempt < 5 && !customer; attempt += 1) {
        const found = await callAction<FindResult>(
          session,
          "/payments/new",
          findId,
          [pick(terms)],
          "counter.find_customer",
        );
        if (found?.ok) customer = pick(found.customers.filter((c) => c.active));
      }
      if (!customer) {
        ctx.recorder.count("counter.no_customer_found");
        continue;
      }
      const rupees = 100 + 50 * Math.floor(Math.random() * 9);
      const taken = await callAction<TakeResult>(
        session,
        "/payments/new",
        takeId,
        [{ id: uuidv7(), customerId: customer.id, amountPaise: rupees * 100, method: "cash" }],
        "counter.take_payment",
      );
      if (taken?.ok) ctx.recorder.count("counter.payments_posted");
      else ctx.recorder.count("counter.payments_refused");
    }
  });
}

/** List and report pages (all render on the server). `owner`: Owner-only pages. */
export const REPORT_PAGES: ReadonlyArray<{ name: string; path: string; owner?: boolean }> = [
  { name: "home", path: "/home" },
  { name: "customers", path: "/customers" },
  { name: "customers_page_5", path: "/customers?page=5" },
  { name: "payments", path: "/payments" },
  { name: "payments_review", path: "/payments/review" },
  { name: "bills", path: "/bills" },
  { name: "bills_runs", path: "/bills/runs" },
  { name: "bills_register", path: "/bills/register" },
  { name: "linemen", path: "/linemen" },
  { name: "reports_dues", path: "/reports/dues" },
  { name: "reports_bills", path: "/reports/bills" },
  { name: "reports_payments", path: "/reports/payments" },
  { name: "reports_collections", path: "/reports/collections" },
  { name: "reports_handover", path: "/reports/handover" },
  { name: "reports_connections", path: "/reports/connections" },
  { name: "reports_billing_runs", path: "/reports/billing-runs" },
  { name: "audit", path: "/settings/audit", owner: true },
];

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

const CUSTOMER_LINK = /href="\/customers\/([0-9a-f-]{36})"/g;

export async function runReports(ctx: RunContext): Promise<void> {
  const users = await signInAll(plannedWebUsers(ctx), (l) => ctx.web(l), ctx.log, "office user");
  ctx.log(`  ${users.length} office users signed in`);
  await everyone(ctx, users, "office user", async ({ login, session }) => {
    const owner = login.endsWith("-owner");
    const pages = REPORT_PAGES.filter((page) => owner || !page.owner);
    const customerIds: string[] = [];
    for (let round = 0; round < ctx.profile.webRounds; round += 1) {
      for (const page of shuffled(pages)) {
        const answer = await session.request(page.path, { metric: `web.page.${page.name}` });
        if (page.name === "customers" && answer.ok) {
          for (const match of answer.text.matchAll(CUSTOMER_LINK)) {
            if (match[1]) customerIds.push(match[1]);
          }
        }
      }
      for (const [kind, terms] of Object.entries(SEARCH_TERMS)) {
        const q = pick(terms) ?? "";
        await session.request(`/customers?${new URLSearchParams({ q })}`, {
          metric: `web.search.${kind}`,
        });
      }
      const id = pick(customerIds);
      if (id) {
        await session.request(`/customers/${id}`, { metric: "web.page.customer_profile" });
        await session.request(`/customers/${id}/bills`, { metric: "web.page.customer_bills" });
        await session.request(`/customers/${id}/payments`, {
          metric: "web.page.customer_payments",
        });
      }
    }
  });
}

/** Files each Owner downloads, in order: the biggest first. */
export const EXPORT_KINDS = [
  "payments",
  "bills",
  "customers",
  "dues",
  "collections",
  "connections",
  "billing-runs",
  "handover",
] as const;

/**
 * The query of each file: the widest range the page allows for the two big registers (31 days of
 * payments, 12 months of bills, T-082), the page's defaults for the rest.
 */
export function exportQuery(kind: (typeof EXPORT_KINDS)[number], now = new Date()): string {
  const today = istDate(now);
  if (kind === "payments") {
    const from = istDate(new Date(now.getTime() - 30 * 86_400_000));
    return `?${new URLSearchParams({ from, to: today })}`;
  }
  if (kind === "bills") {
    const [year, month] = today.split("-").map(Number) as [number, number];
    const start = new Date(Date.UTC(year, month - 1 - 11, 1)).toISOString().slice(0, 7);
    return `?${new URLSearchParams({ from: start, to: today.slice(0, 7) })}`;
  }
  return "";
}

export async function runExports(ctx: RunContext): Promise<void> {
  if (ctx.profile.exportsPerOwner > MAX_EXPORTS_PER_OWNER) {
    throw new Error(
      `exportsPerOwner must be ≤ ${MAX_EXPORTS_PER_OWNER} (server limit 30 per 15 min)`,
    );
  }
  const owners = await signInAll(plannedExportOwners(ctx), (l) => ctx.web(l), ctx.log, "owner");
  ctx.log(`  ${owners.length} owners signed in`);
  const kinds = EXPORT_KINDS.slice(0, ctx.profile.exportsPerOwner);
  // At most 4 files at once per run: downloads are long and a few Owners at most do this together.
  const jobs = owners.flatMap(({ session }) => kinds.map((kind) => ({ session, kind })));
  const errors = await pool(jobs, Math.min(4, jobs.length), async ({ session, kind }) => {
    const answer = await session.request(`/api/exports/${kind}${exportQuery(kind)}`, {
      metric: `export.${kind}`,
      headers: { "sec-fetch-site": "same-origin" },
      timeoutMs: 330_000,
    });
    if (answer.ok && answer.headers.get("content-type")?.includes("text/csv")) {
      ctx.recorder.count("export.files");
      ctx.recorder.count("export.rows", Math.max(0, answer.text.split("\r\n").length - 2));
    } else if (answer.status === 303) {
      ctx.recorder.count("export.refused");
    }
  });
  for (const error of errors) ctx.log(`  export: ${errorText(error)}`);
  if (errors.length > 0) throw new Error(`${errors.length} downloads stopped with an error`);
}
