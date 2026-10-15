/**
 * A tiny in-process stand-in for the web app (tests only): just enough of `/api/health`, the login
 * form, the counter page's Server Actions, the report pages, the exports, the crons and the mobile
 * API for every scenario to run end to end. Request bodies are checked with the real mobile
 * contract (`@cb/contracts`), so the tool can't drift from what the server accepts.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  APP_VERSION_HEADER,
  LoginRequest,
  PaymentBatchRequest,
  ReceiptActionsRequest,
  RefreshRequest,
} from "@cb/contracts";

export interface FakeTargetOptions {
  /** Paths answered with 500 (to test failing budgets). */
  readonly failPaths?: readonly string[];
  /** `/api/health` status (503 = database down). */
  readonly healthStatus?: number;
  readonly cronSecret?: string;
  /** Billing jobs left before the queue is empty (each worker call finishes one). */
  readonly billingJobs?: number;
}

export interface FakeTarget {
  readonly url: string;
  readonly stats: {
    webSignIns: Map<string, number>;
    mobileSignIns: Map<string, number>;
    refreshes: number;
    payments: Set<string>;
    counterPayments: number;
    exports: number;
    invalidRequests: string[];
    requests: number;
  };
  close(): Promise<void>;
}

const LOGIN_HTML = `<!DOCTYPE html><html><body>
<form aria-label="Language" action="" encType="multipart/form-data" method="POST"><input type="hidden" name="$ACTION_ID_40aa"/><button>EN</button></form>
<form class="flex" noValidate="" action="" encType="multipart/form-data" method="POST"><input type="hidden" name="$ACTION_REF_2"/><input type="hidden" name="$ACTION_2:0" value="{&quot;id&quot;:&quot;60d6&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/><input type="hidden" name="$ACTION_2:1" value="[{}]"/><input type="hidden" name="$ACTION_KEY" value="k92a"/><input type="text" id="login" name="login" value=""/><input type="password" id="password" name="password"/></form>
</body></html>`;

const FIND_ID = "4034f2a2c6a1bb8c8858643257d757a57c24763b1c";
const TAKE_ID = "40a33e2c04bbd4a740e64a67a85c0e2c6e937f268a";
const flight = (chunk: string) =>
  `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`;
const COUNTER_HTML = `<!DOCTYPE html><html><body><main>Take payment</main>${flight(
  `0:{"P":null}\n1f:["$","$L20",null,{"initialCustomer":null,"findCustomers":"$h21","takePayment":"$h22","copyReceiptLink":"$h23"}]\n`,
)}${flight(`21:{"id":"${FIND_ID}","bound":null}\n22:{"id":"${TAKE_ID}","bound":null}\n23:{"id":"4020fb97","bound":null}\n`)}</body></html>`;

const CUSTOMERS = Array.from({ length: 30 }, (_, i) => ({
  id: `0192${String(i).padStart(4, "0")}-0000-7000-8000-000000000000`,
  active: i % 7 !== 0,
}));

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

const serverTime = () => new Date().toISOString();

export async function startFakeTarget(options: FakeTargetOptions = {}): Promise<FakeTarget> {
  const stats: FakeTarget["stats"] = {
    webSignIns: new Map(),
    mobileSignIns: new Map(),
    refreshes: 0,
    payments: new Set(),
    counterPayments: 0,
    exports: 0,
    invalidRequests: [],
    requests: 0,
  };
  const sessions = new Set<string>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>(); // token → install id
  let billingJobs = options.billingJobs ?? 2;
  let billingQueued = false;
  const invalid = (what: string) => stats.invalidRequests.push(what);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    stats.requests += 1;
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    if (options.failPaths?.includes(path)) {
      res.writeHead(500).end("boom");
      return;
    }
    const text = await body(req);
    const cookie = req.headers.cookie ?? "";
    const signedIn = [...sessions].some((token) => cookie.includes(`cb.session_token=${token}`));

    if (path === "/api/health") {
      const status = options.healthStatus ?? 200;
      json(res, status, {
        status: status === 200 ? "ok" : "degraded",
        version: "0.1.0",
        commit: "abc123",
        checks: { db: { status: status === 200 ? "ok" : "error" } },
      });
      return;
    }

    // ── Web sign-in (the no-JavaScript form post) ──
    if (path === "/login" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html" }).end(LOGIN_HTML);
      return;
    }
    if (path === "/login" && req.method === "POST") {
      const form = new URLSearchParams();
      // Multipart: pull the simple fields out by name (good enough for a fake).
      for (const match of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) {
        form.set(match[1] ?? "", match[2] ?? "");
      }
      if (!form.has("$ACTION_REF_2") || form.get("$ACTION_KEY") !== "k92a") invalid("login form");
      if (req.headers.origin === undefined) invalid("login origin");
      const login = form.get("login") ?? "";
      stats.webSignIns.set(login, (stats.webSignIns.get(login) ?? 0) + 1);
      if (form.get("password") !== "seed-dev-password") {
        res.writeHead(200, { "content-type": "text/html" }).end(LOGIN_HTML);
        return;
      }
      const token = randomUUID();
      sessions.add(token);
      res.writeHead(303, {
        location: "/home",
        "set-cookie": `cb.session_token=${token}; Path=/; HttpOnly; SameSite=lax`,
      });
      res.end();
      return;
    }

    // ── Crons ──
    if (path.startsWith("/api/cron/")) {
      if (req.headers.authorization !== `Bearer ${options.cronSecret ?? "cron"}`) {
        json(res, 401, { error: "UNAUTHORIZED" });
        return;
      }
      if (path === "/api/cron/billing-scheduler") {
        const open = billingJobs > 0;
        const first = !billingQueued;
        billingQueued = true;
        json(res, 200, {
          period: "2026-10-01",
          billingDay: false,
          tenants: 2,
          outcomes: {
            queued: first && open ? 2 : 0,
            requeued: 0,
            in_progress: !first && open ? 2 : 0,
            done: open ? 0 : 2,
            skipped: 0,
            read_only: 0,
          },
          errors: 0,
        });
        return;
      }
      if (path === "/api/cron/job-worker") {
        const claimed = billingJobs > 0 ? 1 : 0;
        billingJobs = Math.max(0, billingJobs - 1);
        json(res, 200, {
          claimed,
          succeeded: claimed,
          continued: 0,
          retried: 0,
          failed: 0,
          leaseLost: 0,
          stoppedBy: "queue_empty",
          durationMs: 5,
        });
        return;
      }
    }

    // ── Mobile API ──
    if (path.startsWith("/api/mobile/v1/")) {
      if (!/^[1-9][0-9]*$/.test(String(req.headers[APP_VERSION_HEADER] ?? ""))) {
        invalid(`${path} without ${APP_VERSION_HEADER}`);
      }
      const route = path.slice("/api/mobile/v1".length);
      if (route === "/auth/login") {
        const parsed = LoginRequest.safeParse(JSON.parse(text));
        if (!parsed.success) {
          invalid("mobile login body");
          json(res, 400, { error: { code: "VALIDATION" } });
          return;
        }
        const login = parsed.data.login;
        stats.mobileSignIns.set(login, (stats.mobileSignIns.get(login) ?? 0) + 1);
        const access = randomUUID();
        const refresh = randomUUID();
        accessTokens.add(access);
        refreshTokens.set(refresh, parsed.data.device.install_id);
        json(res, 200, {
          server_time: serverTime(),
          tokens: {
            token_type: "Bearer",
            access_token: access,
            access_token_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
            refresh_token: refresh,
            refresh_token_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString(),
          },
          user: { id: randomUUID(), name: "L", login, language: "hi" },
          operator: { id: randomUUID(), name: "Op", office_phone: null, receipt_footer: null },
          device: { id: randomUUID(), device_code: "K01" },
        });
        return;
      }
      if (route === "/auth/refresh") {
        const parsed = RefreshRequest.safeParse(JSON.parse(text));
        const install = parsed.success ? refreshTokens.get(parsed.data.refresh_token) : undefined;
        if (!parsed.success || install !== parsed.data.install_id) {
          json(res, 401, { error: { code: "REFRESH_TOKEN_INVALID" } });
          return;
        }
        stats.refreshes += 1;
        refreshTokens.delete(parsed.data.refresh_token);
        const access = randomUUID();
        const refresh = randomUUID();
        accessTokens.add(access);
        refreshTokens.set(refresh, install);
        json(res, 200, {
          server_time: serverTime(),
          tokens: {
            token_type: "Bearer",
            access_token: access,
            access_token_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
            refresh_token: refresh,
            refresh_token_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString(),
          },
        });
        return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!accessTokens.has(bearer)) {
        json(res, 401, { error: { code: "UNAUTHENTICATED" } });
        return;
      }
      if (route === "/app/config") {
        json(res, 200, { server_time: serverTime(), min_app_version_code: 1 });
        return;
      }
      if (route === "/sync/customers") {
        const cursor = url.searchParams.get("cursor");
        const page = cursor === null ? 0 : Number(cursor.split("-")[1] ?? 9);
        const rows = cursor?.startsWith("delta") ? [] : CUSTOMERS.slice(page * 20, page * 20 + 20);
        const hasMore =
          cursor === null || cursor.startsWith("page") ? page * 20 + 20 < CUSTOMERS.length : false;
        json(res, 200, {
          server_time: serverTime(),
          customers: rows.map((c) => ({ id: c.id, active: c.active, balance_paise: 10_000 })),
          removed_customer_ids: [],
          next_cursor: hasMore ? `page-${page + 1}` : "delta-0",
          has_more: hasMore,
        });
        return;
      }
      if (route.startsWith("/customers/")) {
        json(res, 200, { server_time: serverTime(), customer: {} });
        return;
      }
      if (route === "/payments:batch") {
        const parsed = PaymentBatchRequest.safeParse(JSON.parse(text));
        if (!parsed.success) {
          invalid(`payment batch: ${parsed.error.issues[0]?.message}`);
          json(res, 400, { error: { code: "VALIDATION" } });
          return;
        }
        const results = parsed.data.payments.map((p) => {
          const known = stats.payments.has(p.id);
          stats.payments.add(p.id);
          return { id: p.id, outcome: known ? "duplicate" : "posted" };
        });
        json(res, 200, { server_time: serverTime(), results });
        return;
      }
      if (route === "/receipts/actions:batch") {
        const parsed = ReceiptActionsRequest.safeParse(JSON.parse(text));
        if (!parsed.success) invalid("receipt actions");
        json(res, 200, { server_time: serverTime(), results: [] });
        return;
      }
      if (route.startsWith("/collections/")) {
        if (!/^\/collections\/\d{4}-\d{2}-\d{2}$/.test(route)) invalid("collections date");
        json(res, 200, { server_time: serverTime(), day: {} });
        return;
      }
      json(res, 404, { error: { code: "NOT_FOUND" } });
      return;
    }

    // ── Signed-in web pages ──
    if (!signedIn) {
      res.writeHead(307, { location: "/login" }).end();
      return;
    }
    if (path === "/payments/new" && req.method === "POST") {
      const action = req.headers["next-action"];
      if (req.headers.origin === undefined) invalid("action origin");
      const args = JSON.parse(text) as unknown[];
      res.writeHead(200, { "content-type": "text/x-component" });
      if (action === FIND_ID) {
        const found = CUSTOMERS.slice(0, 8).map((c) => ({ id: c.id, active: c.active }));
        res.end(`0:{"a":"$@1","b":"x"}\n1:${JSON.stringify({ ok: true, customers: found })}\n`);
        return;
      }
      if (action === TAKE_ID) {
        const input = args[0] as { id?: string; amountPaise?: number };
        if (!Number.isInteger(input.amountPaise)) invalid("counter amount");
        stats.counterPayments += 1;
        res.end(
          `0:{"a":"$@1","b":"x"}\n1:${JSON.stringify({ ok: true, payment: { paymentId: input.id } })}\n`,
        );
        return;
      }
      invalid(`unknown action ${action}`);
      res.end("");
      return;
    }
    if (path === "/payments/new") {
      res.writeHead(200, { "content-type": "text/html" }).end(COUNTER_HTML);
      return;
    }
    if (path.startsWith("/api/exports/")) {
      stats.exports += 1;
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      res.end("﻿a,b\r\n1,2\r\n3,4\r\n");
      return;
    }
    const links = CUSTOMERS.slice(0, 5)
      .map((c) => `<a href="/customers/${c.id}">${c.id}</a>`)
      .join("");
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(`<html><body>${path}${links}</body></html>`);
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      invalid(`fake target crashed: ${error instanceof Error ? error.message : error}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
