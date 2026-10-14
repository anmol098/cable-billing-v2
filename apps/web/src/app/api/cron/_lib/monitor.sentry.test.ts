// @vitest-environment node
/**
 * The cron check-ins through the real `@sentry/nextjs` server SDK (T-096a), with Sentry's documented
 * `transport` option capturing envelopes instead of sending them: what a monitored cron hands to the
 * SDK, and that an unreachable Sentry (connection refused) does not change the cron's answer.
 * Never sent to a real Sentry (no account exists before H-01).
 */
import * as Sentry from "@sentry/nextjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "r".repeat(48);
const DSN = "https://publickey@o1.ingest.sentry.io/42";
// `serverEnv` is read when `@/env` is first imported: set the DSN before loading the cron plumbing,
// so the default check-in sink (Sentry when SENTRY_DSN is set) is the one under test.
vi.stubEnv("SENTRY_DSN", DSN);
const { cronRoute } = await import("./cron");
afterAll(() => {
  vi.unstubAllEnvs();
});
const call = () =>
  new Request("http://localhost/api/cron/job-worker", {
    headers: { authorization: `Bearer ${SECRET}` },
  });

type Item = [{ type: string }, Record<string, unknown>];

describe("check-ins through the real Sentry SDK", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    await Sentry.close(1_000);
  });

  it("sends in_progress then ok for the same check-in id, with the monitor slug", async () => {
    const items: Item[] = [];
    Sentry.init({
      dsn: DSN,
      environment: "test",
      tracesSampleRate: 0,
      transport: () => ({
        send: async (envelope) => {
          for (const item of envelope[1] as unknown as Item[]) items.push(item);
          return {};
        },
        flush: async () => true,
      }),
    });
    const route = cronRoute("job_worker", async () => ({ claimed: 0 }), { secret: () => SECRET });
    expect((await route(call())).status).toBe(200);

    const checkIns = items.filter(([header]) => header.type === "check_in").map(([, body]) => body);
    expect(checkIns).toHaveLength(2);
    expect(checkIns[0]).toMatchObject({ monitor_slug: "cron-job-worker", status: "in_progress" });
    expect(checkIns[1]).toMatchObject({
      monitor_slug: "cron-job-worker",
      status: "ok",
      check_in_id: checkIns[0]?.check_in_id,
      environment: "test",
    });
    expect(typeof checkIns[1]?.duration).toBe("number");
    // The monitor's schedule lives in alerts.json (sentry-alerts.mjs), not in check-ins.
    expect(checkIns[0]?.monitor_config).toBeUndefined();
  });

  it("an error run sends error, and the exception too", async () => {
    const items: Item[] = [];
    Sentry.init({
      dsn: DSN,
      tracesSampleRate: 0,
      transport: () => ({
        send: async (envelope) => {
          for (const item of envelope[1] as unknown as Item[]) items.push(item);
          return {};
        },
        flush: async () => true,
      }),
    });
    const route = cronRoute(
      "invariants",
      async () => {
        throw new Error("db down");
      },
      { secret: () => SECRET },
    );
    expect((await route(call())).status).toBe(500);
    const types = items.map(([header]) => header.type);
    expect(types).toContain("event");
    const statuses = items
      .filter(([header]) => header.type === "check_in")
      .map(([, body]) => body.status);
    expect(statuses).toEqual(["in_progress", "error"]);
  });

  it("an unreachable Sentry (connection refused) does not change the cron's answer", async () => {
    Sentry.init({ dsn: "http://publickey@127.0.0.1:1/42", tracesSampleRate: 0 });
    const route = cronRoute("billing_scheduler", async () => ({ created: 4 }), {
      secret: () => SECRET,
    });
    const response = await route(call());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: 4 });
  }, 15_000);
});
