// @vitest-environment node
/**
 * Cron route plumbing (T-043): CRON_SECRET bearer check, refusal without a secret, error handling,
 * the stubs, every scheduled path has a route, and the alert email words.
 */
import { readFileSync } from "node:fs";
import type { JobFailure } from "@cb/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => true),
}));
vi.mock("@sentry/nextjs", () => sentry);

const { checkCronAuthorization } = await import("./auth");
const { cronRoute, cronStub } = await import("./cron");
const { renderJobAlert } = await import("./alerts");

const SECRET = "s3cr3t-value-for-tests-0123456789";
const request = (authorization?: string) =>
  new Request("http://localhost/api/cron/x", {
    headers: authorization === undefined ? {} : { authorization },
  });

describe("checkCronAuthorization", () => {
  it("accepts exactly `Bearer <secret>`", () => {
    expect(checkCronAuthorization(`Bearer ${SECRET}`, SECRET)).toBe("ok");
    for (const header of [
      null,
      undefined,
      "",
      SECRET,
      `bearer ${SECRET}`,
      `Bearer ${SECRET} `,
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(0, -1)}`,
      "Bearer ",
    ]) {
      expect(checkCronAuthorization(header, SECRET), String(header)).toBe("unauthorized");
    }
  });

  it("refuses everything when no secret is configured", () => {
    expect(checkCronAuthorization("Bearer ", undefined)).toBe("not_configured");
    expect(checkCronAuthorization("Bearer ", "")).toBe("not_configured");
    expect(checkCronAuthorization(null, undefined)).toBe("not_configured");
  });
});

describe("cronRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  const run = vi.fn(async () => ({ done: 3 }));
  const route = cronRoute("tests_cron", run, { secret: () => SECRET });

  it("503 without a configured secret, and nothing runs", async () => {
    const unconfigured = cronRoute("tests_cron", run, { secret: () => undefined });
    const response = await unconfigured(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "CRON_NOT_CONFIGURED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("401 on a missing or wrong header, and nothing runs", async () => {
    for (const header of [undefined, "Bearer nope"]) {
      const response = await route(request(header));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("runs with the right header and returns the result as JSON", async () => {
    const response = await route(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ done: 3 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("an exception → 500 without details, logged and sent to Sentry", async () => {
    const failing = cronRoute(
      "tests_cron",
      async () => {
        throw new Error("db down");
      },
      { secret: () => SECRET },
    );
    const response = await failing(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("db down");
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.flush).toHaveBeenCalled();
  });

  it("stubs authenticate first, then answer 501 naming the owning task", async () => {
    const stub = cronStub("tests_stub", "T-999");
    // No CRON_SECRET in the test environment → refused before anything else.
    expect((await stub(request(`Bearer ${SECRET}`))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", SECRET);
    try {
      vi.resetModules();
      const fresh = await import("./cron");
      const freshStub = fresh.cronStub("tests_stub", "T-999");
      expect((await freshStub(request("Bearer wrong"))).status).toBe(401);
      const ok = await freshStub(request(`Bearer ${SECRET}`));
      expect(ok.status).toBe(501);
      expect(await ok.json()).toEqual({
        error: "NOT_IMPLEMENTED",
        cron: "tests_stub",
        ownerTask: "T-999",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("scheduled routes", () => {
  const config = JSON.parse(
    readFileSync(new URL("../../../../../vercel.json", import.meta.url), "utf8"),
  ) as { crons: Array<{ path: string }>; functions?: unknown };

  it("every cron in vercel.json has a route with GET and maxDuration ≤ 300 s", async () => {
    expect(config.functions).toBeUndefined(); // a glob matching no file fails the Vercel build
    for (const { path } of config.crons) {
      const name = path.replace("/api/cron/", "");
      const mod = (await import(`../${name}/route.ts`)) as {
        GET?: unknown;
        maxDuration?: number;
        runtime?: string;
      };
      expect(typeof mod.GET, name).toBe("function");
      expect(mod.runtime, name).toBe("nodejs");
      expect(mod.maxDuration, name).toBeGreaterThan(0);
      expect(mod.maxDuration, name).toBeLessThanOrEqual(300);
    }
  });
});

describe("renderJobAlert", () => {
  const failure: JobFailure = {
    jobId: "0199c4f6-0000-7000-8000-000000000001",
    type: "billing.run",
    operatorId: "0199c4f6-0000-7000-8000-0000000000aa",
    attempts: 5,
    maxAttempts: 5,
    reason: "max_attempts",
    lastError: "Error sqlstate=40001",
    failedAt: new Date("2026-10-12T18:45:00Z"), // 13 Oct 00:15 IST
    notifyOwner: true,
  };

  it("admin email: the technical details, in the admin's language", async () => {
    for (const language of ["en", "hi"] as const) {
      const { subject, text } = await renderJobAlert({
        audience: "platform_admin",
        language,
        failure,
      });
      expect(subject).toContain("billing.run");
      for (const part of [
        failure.jobId,
        failure.operatorId ?? "",
        "Error sqlstate=40001",
        "12:15",
      ]) {
        expect(text, language).toContain(part);
      }
      expect(text).not.toMatch(/[{}]/);
    }
    const platform = await renderJobAlert({
      audience: "platform_admin",
      language: "en",
      failure: { ...failure, operatorId: null },
    });
    expect(platform.text).toContain("none (platform job)");
  });

  it("owner email: plain words, no error text", async () => {
    const en = await renderJobAlert({ audience: "owner", language: "en", failure });
    expect(en.subject).toBe("An automatic task did not finish");
    expect(en.text).not.toContain("sqlstate");
    expect(en.text).toContain(failure.jobId);
    const hi = await renderJobAlert({ audience: "owner", language: "hi", failure });
    expect(hi.subject).not.toBe(en.subject);
    expect(hi.text).not.toMatch(/[{}]/);
  });
});
