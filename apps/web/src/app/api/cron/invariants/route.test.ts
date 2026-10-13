// @vitest-environment node
/**
 * `/api/cron/invariants` (T-052): only Vercel Cron's `Bearer <CRON_SECRET>` may queue the nightly
 * check; without a configured secret nothing runs (503); with it the route queues
 * `invariants.check` through `enqueueInvariantsCheck` and answers its result. The job itself is
 * tested against a real database in `@cb/core` (packages/core/src/invariants).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => true),
}));
vi.mock("@sentry/nextjs", () => sentry);

const enqueue = vi.hoisted(() =>
  vi.fn(async (_db: unknown) => ({ jobId: "0199c4f6-0000-7000-8000-0000000000aa", created: true })),
);
vi.mock("@cb/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cb/core")>()),
  enqueueInvariantsCheck: enqueue,
}));

const SECRET = "i".repeat(64);
const request = (authorization?: string) =>
  new Request("http://localhost/api/cron/invariants", {
    headers: authorization === undefined ? {} : { authorization },
  });

async function loadRoute(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return import("./route");
}

describe("GET /api/cron/invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a Node.js route with a time limit", async () => {
    const route = await loadRoute({});
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(300);
  });

  it("503 when CRON_SECRET is not configured, and nothing is queued", async () => {
    const { GET } = await loadRoute({ CRON_SECRET: "" });
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("401 without the right bearer token, and nothing is queued", async () => {
    const { GET } = await loadRoute({ CRON_SECRET: SECRET });
    for (const header of [undefined, "", SECRET, `Bearer ${SECRET}x`, "Bearer wrong"]) {
      const response = await GET(request(header));
      expect(response.status, String(header)).toBe(401);
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("queues the check job with the secret and answers its id", async () => {
    const { GET } = await loadRoute({
      CRON_SECRET: SECRET,
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/cable_billing",
    });
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      jobId: "0199c4f6-0000-7000-8000-0000000000aa",
      created: true,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const db = enqueue.mock.calls[0]?.[0] as { withPlatform?: unknown };
    expect(typeof db.withPlatform).toBe("function");
  });

  it("a failure to queue answers 500 without details and goes to Sentry", async () => {
    enqueue.mockRejectedValueOnce(new Error("connection refused for 9876543210"));
    const { GET } = await loadRoute({
      CRON_SECRET: SECRET,
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/cable_billing",
    });
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("9876543210");
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
