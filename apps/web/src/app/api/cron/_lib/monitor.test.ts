// @vitest-environment node
/**
 * Sentry cron check-ins for the cron routes (T-096a), against a fake sink and a mocked SDK:
 * nothing without a DSN, `in_progress` → `ok` / `error` with one id when configured, never for an
 * unauthenticated call or an unmonitored cron, and a failing or hanging Sentry never changes the
 * cron's answer. `monitor.sentry.test.ts` runs the real SDK.
 */
import { readFileSync } from "node:fs";
import type { Logger } from "@cb/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureCheckIn: vi.fn((_checkIn: unknown) => "sdk-check-in-id"),
  flush: vi.fn(async (_timeout?: number) => true),
}));
vi.mock("@sentry/nextjs", () => sentry);

const { cronRoute } = await import("./cron");
const { CHECK_IN_FLUSH_MS, CRON_MONITORS, startCronMonitor } = await import("./monitor");
type CheckInSink = import("./monitor").CheckInSink;
type CheckIn = import("./monitor").CheckIn;

const SECRET = "m".repeat(48);
const request = (authorization?: string) =>
  new Request("http://localhost/api/cron/x", {
    headers: authorization === undefined ? {} : { authorization },
  });

function fakeSink(overrides: Partial<CheckInSink> = {}) {
  const sent: CheckIn[] = [];
  let next = 0;
  const sink: CheckInSink = {
    capture: vi.fn((checkIn: CheckIn) => {
      sent.push(checkIn);
      next += 1;
      return `id-${next}`;
    }),
    flush: vi.fn(async () => true),
    ...overrides,
  };
  return { sink, sent };
}

const quietLog = (): Logger & { warns: string[] } => {
  const warns: string[] = [];
  const log = {
    warns,
    info: () => {},
    error: () => {},
    debug: () => {},
    warn: (event: string) => {
      warns.push(event);
    },
    child: () => log,
  };
  return log as unknown as Logger & { warns: string[] };
};

describe("cronRoute check-ins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const monitored = (run: () => Promise<Record<string, unknown> | Response>, sink: CheckInSink) =>
    cronRoute("billing_scheduler", run, { secret: () => SECRET, checkIns: () => sink });

  /** `serverEnv` is read at import: stub the environment, then load fresh modules. */
  async function withEnv(env: Record<string, string>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    return { ...(await import("./cron")), ...(await import("./monitor")) };
  }

  it("without SENTRY_DSN: no check-in and nothing extra, the cron answers as before", async () => {
    const fresh = await withEnv({ SENTRY_DSN: "" });
    expect(fresh.defaultCheckIns()).toBeUndefined();
    const route = fresh.cronRoute("billing_scheduler", async () => ({ created: 2 }), {
      secret: () => SECRET,
    });
    const response = await route(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: 2 });
    expect(sentry.captureCheckIn).not.toHaveBeenCalled();
    expect(sentry.flush).not.toHaveBeenCalled();
  });

  it("with SENTRY_DSN: Sentry.captureCheckIn in_progress, then ok with its id, then a flush", async () => {
    const fresh = await withEnv({ SENTRY_DSN: "https://key@o1.ingest.sentry.io/42" });
    expect(fresh.defaultCheckIns()).toBe(fresh.sentryCheckIns);
    const route = fresh.cronRoute("job_worker", async () => ({ claimed: 0 }), {
      secret: () => SECRET,
    });
    expect((await route(request(`Bearer ${SECRET}`))).status).toBe(200);
    expect(sentry.captureCheckIn).toHaveBeenCalledTimes(2);
    expect(sentry.captureCheckIn.mock.calls[0]?.[0]).toEqual({
      monitorSlug: "cron-job-worker",
      status: "in_progress",
    });
    expect(sentry.captureCheckIn.mock.calls[1]?.[0]).toMatchObject({
      monitorSlug: "cron-job-worker",
      status: "ok",
      checkInId: "sdk-check-in-id",
      duration: expect.any(Number),
    });
    expect(sentry.flush).toHaveBeenCalledWith(CHECK_IN_FLUSH_MS);
  });

  it("ok for a 2xx answer, with the in_progress id and a duration in seconds", async () => {
    const { sink, sent } = fakeSink();
    const response = await monitored(
      async () => ({ created: 1 }),
      sink,
    )(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(sent).toEqual([
      { monitorSlug: "cron-billing-scheduler", status: "in_progress" },
      {
        monitorSlug: "cron-billing-scheduler",
        status: "ok",
        checkInId: "id-1",
        duration: expect.any(Number),
      },
    ]);
    const closing = sent[1] as { duration: number };
    expect(closing.duration).toBeGreaterThanOrEqual(0);
    expect(closing.duration).toBeLessThan(60);
    expect(sink.flush).toHaveBeenCalledTimes(1);
  });

  it("error when the run throws: still 500, the exception captured, one flush", async () => {
    const { sink, sent } = fakeSink();
    const route = monitored(async () => {
      throw new Error("db down");
    }, sink);
    const response = await route(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect(sent.map((c) => c.status)).toEqual(["in_progress", "error"]);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sink.flush).toHaveBeenCalledTimes(1);
    expect(sentry.flush).not.toHaveBeenCalled(); // the sink's flush sent the exception as well
  });

  it("error when the run answers a non-2xx Response (e.g. a 501 stub)", async () => {
    const { sink, sent } = fakeSink();
    const route = monitored(async () => new Response(null, { status: 501 }), sink);
    expect((await route(request(`Bearer ${SECRET}`))).status).toBe(501);
    expect(sent.map((c) => c.status)).toEqual(["in_progress", "error"]);
  });

  it("no check-in for an unauthenticated call or a missing secret (nothing ran)", async () => {
    const { sink, sent } = fakeSink();
    const run = vi.fn(async () => ({}));
    expect((await monitored(run, sink)(request("Bearer wrong"))).status).toBe(401);
    const unconfigured = cronRoute("billing_scheduler", run, {
      secret: () => undefined,
      checkIns: () => sink,
    });
    expect((await unconfigured(request(`Bearer ${SECRET}`))).status).toBe(503);
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("no check-in for a cron without a monitor", async () => {
    const { sink, sent } = fakeSink();
    const route = cronRoute("receipt_links_cleanup", async () => ({}), {
      secret: () => SECRET,
      checkIns: () => sink,
    });
    expect((await route(request(`Bearer ${SECRET}`))).status).toBe(200);
    expect(sent).toEqual([]);
    expect(sink.flush).not.toHaveBeenCalled();
  });

  it("an exception in an unmonitored cron is still flushed (as before T-096a)", async () => {
    const route = cronRoute(
      "receipt_links_cleanup",
      async () => {
        throw new Error("x");
      },
      { secret: () => SECRET, checkIns: () => fakeSink().sink },
    );
    expect((await route(request(`Bearer ${SECRET}`))).status).toBe(500);
    expect(sentry.flush).toHaveBeenCalledTimes(1);
  });

  it("Sentry failing never changes the cron's answer", async () => {
    const throwing = fakeSink({
      capture: () => {
        throw new Error("transport down");
      },
      flush: () => Promise.reject(new Error("network unreachable")),
    });
    const response = await monitored(
      async () => ({ created: 3 }),
      throwing.sink,
    )(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: 3 });

    const throwingFailed = await monitored(async () => {
      throw new Error("real failure");
    }, throwing.sink)(request(`Bearer ${SECRET}`));
    expect(throwingFailed.status).toBe(500);
  });
});

describe("startCronMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing without a sink or for an unmonitored name", async () => {
    const log = quietLog();
    expect(startCronMonitor("billing_scheduler", undefined, log).monitored).toBe(false);
    const { sink, sent } = fakeSink();
    const run = startCronMonitor("session_close", sink, log);
    expect(run.monitored).toBe(false);
    await run.finish("ok");
    expect(sent).toEqual([]);
  });

  it("uses the clock for the duration", async () => {
    const { sink, sent } = fakeSink();
    let t = 1_000;
    const run = startCronMonitor("invariants", sink, quietLog(), () => t);
    t += 2_500;
    await run.finish("ok");
    expect(sent[1]).toEqual({
      monitorSlug: "cron-invariants",
      status: "ok",
      checkInId: "id-1",
      duration: 2.5,
    });
  });

  it("closes with a plain heartbeat when in_progress could not be sent", async () => {
    const sent: CheckIn[] = [];
    let calls = 0;
    const sink: CheckInSink = {
      capture: (checkIn) => {
        calls += 1;
        if (calls === 1) throw new Error("first one fails");
        sent.push(checkIn);
        return "x";
      },
      flush: async () => true,
    };
    const log = quietLog();
    const run = startCronMonitor("subscription_states", sink, log);
    await run.finish("error");
    expect(sent).toEqual([{ monitorSlug: "cron-subscription-states", status: "error" }]);
    expect(log.warns).toEqual(["cron.check_in_failed"]);
  });

  it("a flush that never settles is abandoned shortly after the flush timeout", async () => {
    vi.useFakeTimers();
    const { sink } = fakeSink({ flush: () => new Promise<boolean>(() => {}) });
    const log = quietLog();
    let done = false;
    void startCronMonitor("job_worker", sink, log)
      .finish("ok")
      .then(() => {
        done = true;
      });
    await vi.advanceTimersByTimeAsync(CHECK_IN_FLUSH_MS);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(true);
    expect(log.warns).toEqual(["cron.check_in_not_flushed"]);
  });

  it("logs a flush that timed out (Sentry unreachable) and carries on", async () => {
    const { sink } = fakeSink({ flush: async () => false });
    const log = quietLog();
    await startCronMonitor("job_worker", sink, log).finish("ok");
    expect(log.warns).toEqual(["cron.check_in_not_flushed"]);
  });
});

describe("monitored crons", () => {
  const vercel = JSON.parse(
    readFileSync(new URL("../../../../../vercel.json", import.meta.url), "utf8"),
  ) as { crons: Array<{ path: string; schedule: string }> };

  it("each monitored name is the cronRoute name of a scheduled route", () => {
    const routeNames = vercel.crons.map(({ path }) => {
      const folder = path.replace("/api/cron/", "");
      const source = readFileSync(new URL(`../${folder}/route.ts`, import.meta.url), "utf8");
      return /cron(?:Route|Stub)\("([a-z_]+)"/.exec(source)?.[1];
    });
    for (const [name, slug] of Object.entries(CRON_MONITORS)) {
      expect(routeNames, name).toContain(name);
      expect(slug).toMatch(/^cron-[a-z0-9-]+$/);
    }
    expect(new Set(Object.values(CRON_MONITORS)).size).toBe(Object.keys(CRON_MONITORS).length);
  });
});
