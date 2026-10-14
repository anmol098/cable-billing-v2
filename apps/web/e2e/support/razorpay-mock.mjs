/**
 * A tiny stand-in for Razorpay's Subscriptions API for the e2e suite (T-085). Playwright starts it
 * next to `next start` (see playwright.config.ts) and points the app at it with
 * `RAZORPAY_API_BASE_URL` (local tests only; refused on Vercel). The real API is never called.
 *
 * Implements what the app calls (documented shapes): `GET /v1/plans/:id`, `POST /v1/subscriptions`,
 * `GET /v1/subscriptions/:id`, `POST /v1/subscriptions/:id/cancel`. Test control (not Razorpay):
 * `POST /__test/subscriptions/:id` with `{ status, current_end }` plays "the customer paid";
 * `GET /__test/subscriptions` lists what was created. Requests without Basic auth get 401.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.RAZORPAY_MOCK_PORT ?? 3199);
const PLAN = { period: "monthly", interval: 1, item: { amount: 47_200, currency: "INR" } };
const subscriptions = new Map();
let sequence = 0;

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/health") return send(response, 200, { ok: true });
    if (parts[0] === "__test" && parts[1] === "subscriptions") {
      if (request.method === "GET") return send(response, 200, [...subscriptions.values()]);
      const found = subscriptions.get(parts[2]);
      if (!found) return send(response, 404, { error: { code: "NOT_FOUND" } });
      const patch = await readJson(request);
      Object.assign(found, patch);
      return send(response, 200, found);
    }
    if (!(request.headers.authorization ?? "").startsWith("Basic ")) {
      return send(response, 401, { error: { code: "BAD_REQUEST_ERROR" } });
    }
    if (parts[0] !== "v1") return send(response, 404, { error: { code: "NOT_FOUND" } });
    if (parts[1] === "plans" && request.method === "GET") {
      return send(response, 200, { id: parts[2], entity: "plan", ...PLAN });
    }
    if (parts[1] === "subscriptions" && parts.length === 2 && request.method === "POST") {
      const body = await readJson(request);
      sequence += 1;
      const id = `sub_E2eMock${Date.now().toString(36)}${sequence}`;
      const entity = {
        id,
        entity: "subscription",
        plan_id: body.plan_id,
        customer_id: null,
        status: "created",
        current_start: null,
        current_end: null,
        charge_at: body.start_at ?? null,
        start_at: body.start_at ?? null,
        total_count: body.total_count,
        paid_count: 0,
        short_url: `https://example.invalid/${id}`,
        notes: body.notes ?? [],
        created_at: Math.floor(Date.now() / 1000),
      };
      subscriptions.set(id, entity);
      return send(response, 200, entity);
    }
    if (parts[1] === "subscriptions" && parts[2]) {
      const found = subscriptions.get(parts[2]);
      if (!found) return send(response, 400, { error: { code: "BAD_REQUEST_ERROR" } });
      if (parts[3] === "cancel" && request.method === "POST") {
        const body = await readJson(request);
        if (!body.cancel_at_cycle_end) found.status = "cancelled";
        return send(response, 200, found);
      }
      if (request.method === "GET") return send(response, 200, found);
    }
    return send(response, 404, { error: { code: "NOT_FOUND" } });
  } catch {
    return send(response, 500, { error: { code: "SERVER_ERROR" } });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`razorpay mock on http://localhost:${PORT}\n`);
});
