import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInBudgetError } from "./auth";
import { main } from "./cli";
import { PROFILES } from "./profiles";
import { RESULT_SCHEMA } from "./report";
import { type LoadRunInput, runLoad, TargetNotReadyError, warmSessions } from "./run";
import { SCENARIO_NAMES } from "./scenarios";
import { type FakeTarget, startFakeTarget } from "./testing/fake-target";

let dir: string;
let target: FakeTarget | undefined;
const lines: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cb-load-test-"));
  lines.length = 0;
});

afterEach(async () => {
  await target?.close();
  target = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function input(url: string, overrides: Partial<LoadRunInput> = {}): LoadRunInput {
  return {
    baseUrl: url,
    profile: PROFILES.smoke,
    seedScale: "small",
    scenarios: SCENARIO_NAMES,
    password: "seed-dev-password",
    cronSecret: "cron",
    appVersionCode: 1,
    billingWorkers: 1,
    billingPollMs: 10,
    maxSignIns: 90,
    cachePath: join(dir, "sessions.json"),
    log: (line) => lines.push(line),
    ...overrides,
  };
}

describe("runLoad against a fake target", () => {
  it("runs every scenario end to end with contract-valid requests and passes the budget", async () => {
    target = await startFakeTarget();
    const result = await runLoad(input(target.url));

    expect(target.stats.invalidRequests).toEqual([]);
    expect(result.scenarioErrors).toEqual({});
    expect(result.schema).toBe(RESULT_SCHEMA);
    expect(result.pass).toBe(true);
    expect(result.target).toMatchObject({ local: true, version: "0.1.0", commit: "abc123" });
    expect(result.disclaimer).toMatch(/not a capacity measurement/);
    expect(result.scenarios).toEqual([
      "billing",
      "sync",
      "counter",
      "reports",
      "exports",
      "payments",
    ]);

    const names = result.metrics.map((m) => m.name);
    for (const metric of [
      "billing.run.wall",
      "billing.worker",
      "mobile.sync.page",
      "mobile.sync.full",
      "mobile.sync.delta",
      "mobile.customer.detail",
      "mobile.payments.batch",
      "mobile.payments.replay",
      "mobile.receipts.actions",
      "mobile.collections.day",
      "counter.find_customer",
      "counter.take_payment",
      "web.page.reports_dues",
      "web.page.customer_profile",
      "web.search.name",
      "export.payments",
      "export.bills",
    ]) {
      expect(names).toContain(metric);
    }
    // 4 phones × 1 batch × 10 payments, all posted; the replay answered duplicate for each.
    expect(target.stats.payments.size).toBe(40);
    expect(result.counters["mobile.payments.posted"]).toBe(40);
    expect(result.counters["mobile.payments.replay_not_duplicate"]).toBeUndefined();
    expect(result.metrics.find((m) => m.name === "mobile.payments.replay")?.count).toBe(4);
    expect(target.stats.counterPayments).toBe(6);
    expect(result.counters["counter.payments_posted"]).toBe(6);
    expect(target.stats.exports).toBe(4);
    expect(result.counters["billing.runs_done"]).toBe(2);
    expect(result.counters["billing.runs_not_done"]).toBe(0);

    // One sign-in per user: 4 phones, 2 clerks, 2 owners (reports and exports share them).
    expect(result.signIns.real).toBe(8);
    expect([...target.stats.mobileSignIns.values()].every((n) => n === 1)).toBe(true);
    expect([...target.stats.webSignIns.values()].every((n) => n === 1)).toBe(true);
    expect(statSync(join(dir, "sessions.json")).mode & 0o777).toBe(0o600);
  });

  it("reuses cached sign-ins on the next run", async () => {
    target = await startFakeTarget();
    await runLoad(input(target.url, { scenarios: ["sync", "reports"] }));
    const second = await runLoad(input(target.url, { scenarios: ["sync", "reports"] }));
    expect(second.signIns.real).toBe(0);
    expect(second.pass).toBe(true);
    expect([...target.stats.mobileSignIns.values()].every((n) => n === 1)).toBe(true);
  });

  it("refuses a run that needs more sign-ins than allowed, before sending load", async () => {
    target = await startFakeTarget();
    await expect(runLoad(input(target.url, { maxSignIns: 3 }))).rejects.toBeInstanceOf(
      SignInBudgetError,
    );
    expect(target.stats.requests).toBe(5); // the health checks only
  });

  it("warm signs in at most maxSignIns users per call and reports what is missing", async () => {
    target = await startFakeTarget();
    const first = await warmSessions(input(target.url, { maxSignIns: 5 }));
    expect(first).toEqual({ planned: 8, signedIn: 5, failed: 0, missing: 3 });
    const second = await warmSessions(input(target.url, { maxSignIns: 5 }));
    expect(second).toEqual({ planned: 8, signedIn: 3, failed: 0, missing: 0 });
    const run = await runLoad(input(target.url, { maxSignIns: 0 }));
    expect(run.signIns.real).toBe(0);
    expect(run.pass).toBe(true);
  });

  it("stops a scenario (and fails the run) when a user cannot sign in", async () => {
    target = await startFakeTarget();
    const result = await runLoad(
      input(target.url, { scenarios: ["reports"], password: "wrong", cachePath: null }),
    );
    expect(result.scenarioErrors.reports).toMatch(/2 of 2 office users could not sign in/);
    expect(result.pass).toBe(false);
  });

  it("refuses an unhealthy target", async () => {
    target = await startFakeTarget({ healthStatus: 503 });
    await expect(runLoad(input(target.url))).rejects.toBeInstanceOf(TargetNotReadyError);
  });

  it("marks the billing scenario stopped without the cron secret, and fails the result", async () => {
    target = await startFakeTarget();
    const result = await runLoad(
      input(target.url, { scenarios: ["billing"], cronSecret: undefined }),
    );
    expect(result.scenarioErrors.billing).toMatch(/CRON_SECRET/);
    expect(result.pass).toBe(false);
    // Its "0 failed jobs" lines are not counted as measured.
    expect(result.budget.find((line) => line.id === "B-BILLING-FAILED")?.status).toBe(
      "not_measured",
    );
  });
});

describe("cli main", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 1 with --gate when a page fails, and writes summary.json + summary.md", async () => {
    target = await startFakeTarget({ failPaths: ["/reports/dues"] });
    const out = join(dir, "out");
    const argv = [
      "run",
      "--base-url",
      target.url,
      "--seed-scale",
      "small",
      "--scenarios",
      "reports",
      "--no-cache",
    ];
    const code = await main([...argv, "--out", out, "--gate"]);
    expect(code).toBe(1);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary.pass).toBe(false);
    const failed = summary.budget.filter((line: { status: string }) => line.status === "fail");
    expect(failed.map((line: { metric: string }) => line.metric)).toContain(
      "web.page.reports_dues",
    );
    expect(readFileSync(join(out, "summary.md"), "utf8")).toMatch(/\*\*FAIL\*\*/);
    // `check` re-evaluates a stored result with the same verdict.
    expect(await main(["check", join(out, "summary.json"), "--gate"])).toBe(1);
    expect(await main(["check", join(out, "summary.json")])).toBe(0);
  });

  it("exits 3 when the target is not ready and 2 on bad options", async () => {
    target = await startFakeTarget({ healthStatus: 503 });
    expect(await main(["run", "--base-url", target.url, "--no-cache"])).toBe(3);
    expect(await main(["run", "--profile", "huge", "--base-url", target.url])).toBe(2);
    expect(await main(["plan"])).toBe(0);
  });
});
