import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProvisionalRef } from "@cb/contracts";
import { SCALE_CONFIGS } from "@cb/db/seed";
import { describe, expect, it } from "vitest";
import { checkBaseUrl, parseCli, UsageError } from "./args";
import { SessionCache, SignInBudgetError, SignInGovernor } from "./auth";
import { BUDGET_RULES, evaluateBudget } from "./budget";
import { CookieJar } from "./http";
import { installIdFor, istDate, provisionalRefs, uuidv7 } from "./ids";
import { actionIdForProp, actionResult, formSubmission, NextProtocolError } from "./next";
import { seedPersonas, spread } from "./personas";
import { PROFILES } from "./profiles";
import { condensed, isLocalTarget, type RunResult, renderMarkdown } from "./report";
import { exportQuery, MAX_EXPORTS_PER_OWNER } from "./scenarios/web";
import { percentile, Recorder } from "./stats";

const here = dirname(fileURLToPath(import.meta.url));

describe("stats", () => {
  it("uses nearest-rank percentiles", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 100)).toBe(20);
    expect(percentile([], 95)).toBeNull();
    expect(percentile([7], 99)).toBe(7);
  });

  it("keeps failed samples out of the timings but counts them as errors with reasons", () => {
    const recorder = new Recorder();
    recorder.record("x", { ms: 100, ok: true, bytes: 10 });
    recorder.record("x", { ms: 300, ok: true, bytes: 30 });
    recorder.record("x", { ms: 1, ok: false }, "500");
    recorder.count("c", 2);
    recorder.count("c");
    const summary = recorder.summary("x");
    expect(summary).toMatchObject({ count: 3, errors: 1, p50: 100, max: 300, bytesMax: 30 });
    expect(summary.errorRate).toBeCloseTo(1 / 3);
    expect(summary.reasons).toEqual({ "500": 1 });
    expect(recorder.counters()).toEqual({ c: 3 });
  });
});

describe("budget", () => {
  const summary = (name: string, p95: number, errorRate = 0) => ({
    name,
    count: 10,
    errors: Math.round(errorRate * 10),
    errorRate,
    p50: p95,
    p90: p95,
    p95,
    p99: p95,
    max: p95,
    mean: p95,
    bytesMax: 100,
    bytesTotal: 1000,
    reasons: {},
  });

  it("checks every metric a prefix rule matches, counts, and per-profile limits", () => {
    const results = evaluateBudget(
      [
        summary("web.page.home", 1500),
        summary("web.page.reports_dues", 2500),
        summary("billing.run.wall", 40 * 60_000),
      ],
      { "mobile.payments.retry_later": 2 },
      "legacy",
      new Set(["reports", "billing", "payments"]),
    );
    const web = results.filter((line) => line.id === "B-WEB-LIST");
    expect(web.map((line) => [line.metric, line.status])).toEqual([
      ["web.page.home", "pass"],
      ["web.page.reports_dues", "fail"],
    ]);
    expect(results.find((line) => line.id === "B-PAY-RETRY")).toMatchObject({
      actual: 2,
      status: "fail",
    });
    expect(results.find((line) => line.id === "B-PAY-REJECTED")).toMatchObject({
      actual: 0,
      status: "pass",
    });
    expect(results.find((line) => line.id === "B-BILLING-RUN")?.status).toBe("fail");
    expect(results.find((line) => line.id === "B-SYNC-PAGE")?.status).toBe("not_measured");
    expect(results.find((line) => line.id === "B-COUNTER-REFUSED")?.status).toBe("not_measured");

    const tenX = evaluateBudget([summary("billing.run.wall", 40 * 60_000)], {}, "10x", new Set());
    expect(tenX.find((line) => line.id === "B-BILLING-RUN")?.status).toBe("pass");
  });

  it("fails a measured metric that never succeeded", () => {
    const failed = { ...summary("web.page.home", 0, 1), p95: null };
    const results = evaluateBudget([failed], {}, "smoke", new Set(["reports"]));
    expect(results.find((line) => line.id === "B-WEB-LIST")?.status).toBe("fail");
    expect(results.find((line) => line.id === "B-ERRORS")?.status).toBe("fail");
  });

  it("has unique rule ids, each documented in docs/testing/performance.md", () => {
    const ids = BUDGET_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    const doc = readFileSync(join(here, "../../../docs/testing/performance.md"), "utf8");
    for (const id of ids) expect(doc).toContain(`| ${id} |`);
    // …and the doc's budget table lists no rule the code doesn't have.
    const documented = [...doc.matchAll(/^\| (B-[A-Z-]+) \|/gm)].map((m) => m[1]);
    expect(new Set(documented)).toEqual(new Set(ids));
  });

  it("ties the list and search rules to the PRD's 2 s target", () => {
    for (const id of ["B-WEB-LIST", "B-WEB-SEARCH", "B-COUNTER-FIND", "B-SYNC-PAGE"]) {
      const rule = BUDGET_RULES.find((r) => r.id === id);
      expect(rule).toMatchObject({ stat: "p95", limit: 2000 });
      expect(rule?.source).toMatch(/PRD §11/);
    }
  });
});

describe("sign-in budget", () => {
  it("allows each account once and at most maxSignIns sign-ins, never over the server limit", () => {
    const governor = new SignInGovernor(2);
    governor.takeSignIn("a");
    expect(() => governor.takeSignIn("a")).toThrow(SignInBudgetError);
    governor.takeSignIn("b");
    expect(() => governor.takeSignIn("c")).toThrow(/already used its 2 sign-ins/);
    expect(governor.signIns).toBe(2);
    expect(() => new SignInGovernor(101)).toThrow(SignInBudgetError);
    expect(() => new SignInGovernor(-1)).toThrow(SignInBudgetError);
  });

  it("caches sign-ins per target origin and ignores a damaged file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-load-cache-"));
    try {
      const path = join(dir, "s.json");
      const cache = new SessionCache(path);
      cache.set("https://a.example/x", "u1", { kind: "web", cookies: { c: "1" }, savedAt: "t" });
      cache.save();
      const again = new SessionCache(path);
      expect(again.get("https://a.example", "u1")).toMatchObject({
        kind: "web",
        cookies: { c: "1" },
      });
      expect(again.get("https://b.example", "u1")).toBeUndefined();
      writeFileSync(path, "{not json");
      expect(new SessionCache(path).size).toBe(0);
      expect(new SessionCache(null).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the export plan under the 30-per-15-minutes limit", () => {
    expect(MAX_EXPORTS_PER_OWNER).toBeLessThan(30);
    for (const profile of Object.values(PROFILES)) {
      expect(profile.exportsPerOwner).toBeLessThanOrEqual(MAX_EXPORTS_PER_OWNER);
      expect(profile.paymentsPerBatch).toBeLessThanOrEqual(50);
    }
  });
});

describe("Next.js page protocol", () => {
  const loginHtml = `<form aria-label="Language" action="" method="POST"><input type="hidden" name="$ACTION_ID_40e9"/></form>
<form class="flex" noValidate="" action="" encType="multipart/form-data" method="POST"><input type="hidden" name="$ACTION_REF_2"/><input type="hidden" name="$ACTION_2:0" value="{&quot;id&quot;:&quot;60d6&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/><input type="hidden" name="$ACTION_2:1" value="[{}]"/><input type="hidden" name="$ACTION_KEY" value="k92a"/><input type="text" class="x" id="login" name="login" value=""/><input type="password" id="password" name="password"/></form>`;

  it("builds the JavaScript-less sign-in post from the login form's hidden fields", () => {
    const form = formSubmission(loginHtml, { login: "seed-op01-owner", password: "pw" });
    expect([...form.keys()]).toEqual([
      "$ACTION_REF_2",
      "$ACTION_2:0",
      "$ACTION_2:1",
      "$ACTION_KEY",
      "login",
      "password",
    ]);
    expect(form.get("$ACTION_2:0")).toBe('{"id":"60d6","bound":"$@1"}');
    expect(() => formSubmission(loginHtml, { email: "x" })).toThrow(NextProtocolError);
    expect(() => formSubmission('<form><input name="login"/></form>', { login: "x" })).toThrow(
      /no Server Action fields/,
    );
  });

  it("finds a client component's Server Action id in the RSC payload", () => {
    const chunk = (text: string) =>
      `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;
    const html =
      chunk(`1f:["$","$L20",null,{"findCustomers":"$h21","takePayment":"$h22"}]\n`) +
      chunk(`21:{"id":"4034aa","bound":null}\n22:{"id":"40a3bb","bound":null}\n`);
    expect(actionIdForProp(html, "findCustomers")).toBe("4034aa");
    expect(actionIdForProp(html, "takePayment")).toBe("40a3bb");
    expect(() => actionIdForProp(html, "copyReceiptLink")).toThrow(NextProtocolError);
  });

  it("reads an action's return value from its RSC answer", () => {
    const flight = `0:{"a":"$@1","q":"","i":false,"b":"x"}\n1:{"ok":true,"customers":[{"id":"c1"}]}\n`;
    expect(actionResult(flight)).toEqual({ ok: true, customers: [{ id: "c1" }] });
    expect(actionResult("garbage")).toBeUndefined();
  });

  it("keeps cookies from Set-Cookie and drops cleared ones", () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append("set-cookie", "cb.session_token=abc.def; Path=/; HttpOnly");
    headers.append("set-cookie", "other=1; Path=/");
    jar.store(headers);
    expect(jar.header()).toBe("cb.session_token=abc.def; other=1");
    const cleared = new Headers();
    cleared.append("set-cookie", "other=; Max-Age=0; Path=/");
    jar.store(cleared);
    expect(jar.toJSON()).toEqual({ "cb.session_token": "abc.def" });
  });
});

describe("ids", () => {
  it("makes UUIDv7 ids that start with the time", () => {
    const id = uuidv7(Date.UTC(2026, 9, 14));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.replace(/-/g, "").slice(0, 12)).toBe(
      Date.UTC(2026, 9, 14).toString(16).padStart(12, "0"),
    );
  });

  it("keeps one install id per target and login", () => {
    const a = installIdFor("https://x.example", "seed-op01-lineman01");
    expect(a).toBe(installIdFor("https://x.example", "seed-op01-lineman01"));
    expect(a).not.toBe(installIdFor("https://y.example", "seed-op01-lineman01"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("makes provisional references the contract accepts, distinct within a run", () => {
    const next = provisionalRefs("K7Q", Date.UTC(2026, 9, 14, 12));
    const refs = Array.from({ length: 50 }, () => next());
    for (const ref of refs) expect(ProvisionalRef.safeParse(ref).success).toBe(true);
    expect(new Set(refs).size).toBe(50);
  });

  it("dates the collection day in India time", () => {
    expect(istDate(new Date("2026-10-14T18:29:00Z"))).toBe("2026-10-14");
    expect(istDate(new Date("2026-10-14T18:31:00Z"))).toBe("2026-10-15");
  });

  it("asks for the widest export ranges the pages allow", () => {
    const now = new Date("2026-10-14T06:00:00Z");
    expect(exportQuery("payments", now)).toBe("?from=2026-09-14&to=2026-10-14");
    expect(exportQuery("bills", now)).toBe("?from=2025-11&to=2026-10");
    expect(exportQuery("customers", now)).toBe("");
  });
});

describe("personas", () => {
  it("knows the legacy seed's users without reading the database", () => {
    const operators = seedPersonas("legacy");
    expect(operators).toHaveLength(SCALE_CONFIGS.legacy.operators);
    expect(operators.reduce((sum, op) => sum + op.customers, 0)).toBe(7_616);
    const linemen = operators.flatMap((op) => op.linemen);
    // 134 linemen, minus the disabled last one of each of the 8 operators (all have ≥ 4); the
    // seeded legacy database has 126 active linemen.
    expect(linemen.length).toBe(126);
    expect(operators[0]?.owner).toBe("seed-op01-owner");
    expect(operators[0]?.linemen[0]).toBe("seed-op01-lineman01");
    expect(linemen.every((login) => /^seed-op\d{2}-lineman\d{2}$/.test(login))).toBe(true);
  });

  it("spreads users round-robin across operators", () => {
    expect(spread([["a1", "a2"], ["b1"], ["c1", "c2"]], 4)).toEqual(["a1", "b1", "c1", "a2"]);
    expect(spread([["a1"]], 3)).toEqual(["a1"]);
  });
});

describe("options", () => {
  it("defaults to the smoke profile and every scenario", () => {
    const options = parseCli(
      ["run", "--base-url", "https://preview.example/x"],
      {},
      new Date(0),
      "/t",
    );
    expect(options).toMatchObject({
      command: "run",
      baseUrl: "https://preview.example",
      seedScale: "legacy",
      gate: false,
      maxSignIns: 90,
      cachePath: "/t/.cache/sessions.json",
      password: "seed-dev-password",
    });
    expect(options.profile.name).toBe("smoke");
    expect(options.scenarios).toHaveLength(6);
    expect(options.out).toBe("/t/results/1970-01-01T00-00-00-smoke");
  });

  it("reads the environment and refuses bad values", () => {
    const env = {
      LOAD_BASE_URL: "http://localhost:3000",
      LOAD_CRON_SECRET: "s",
      LOAD_PASSWORD: "p",
      LOAD_VERCEL_BYPASS_SECRET: "b",
    };
    const options = parseCli(
      ["run", "--profile", "legacy", "--scenarios", "sync,payments", "--gate"],
      env,
    );
    expect(options).toMatchObject({
      cronSecret: "s",
      password: "p",
      gate: true,
      extraHeaders: { "x-vercel-protection-bypass": "b" },
    });
    expect(options.scenarios).toEqual(["sync", "payments"]);
    expect(() => parseCli(["run"], {})).toThrow(/base-url/);
    expect(() => parseCli(["run", "--scenarios", "nope"], env)).toThrow(UsageError);
    expect(() => parseCli(["run", "--max-sign-ins", "101"], env)).toThrow(UsageError);
    expect(() => parseCli(["explode"], env)).toThrow(UsageError);
    expect(parseCli(["plan"], {}).command).toBe("plan");
  });

  it("never targets a forbidden host", () => {
    expect(() => checkBaseUrl("https://app.cable.example", "app.cable.example, x")).toThrow(
      /never load-test production/,
    );
    expect(checkBaseUrl("https://preview.example/a?b", "app.cable.example")).toBe(
      "https://preview.example",
    );
    expect(() => checkBaseUrl("ftp://x", undefined)).toThrow(UsageError);
  });
});

describe("report", () => {
  it("labels local targets as tooling checks", () => {
    expect(isLocalTarget("http://localhost:3000")).toBe(true);
    expect(isLocalTarget("http://127.0.0.1:1")).toBe(true);
    expect(isLocalTarget("http://192.168.1.4")).toBe(true);
    expect(isLocalTarget("https://cable-billing-git-x.vercel.app")).toBe(false);
  });

  it("condenses passing multi-metric rules and keeps every failure", () => {
    const base = { stat: "p95" as const, limit: 2000, source: "" };
    const rows = condensed([
      { ...base, id: "B-WEB-LIST", metric: "web.page.a", actual: 100, status: "pass" },
      { ...base, id: "B-WEB-LIST", metric: "web.page.b", actual: 300, status: "pass" },
      { ...base, id: "B-WEB-SEARCH", metric: "web.search.x", actual: 2500, status: "fail" },
      { ...base, id: "B-WEB-SEARCH", metric: "web.search.y", actual: 100, status: "pass" },
      { ...base, id: "B-SYNC-PAGE", metric: "x", actual: null, status: "not_measured" },
    ]);
    expect(rows.map((row) => [row.id, row.metric])).toEqual([
      ["B-WEB-LIST", "web.page.* (2 metrics; worst web.page.b)"],
      ["B-WEB-SEARCH", "web.search.x"],
    ]);
  });

  it("renders the disclaimer, the verdict and the timings", () => {
    const result = {
      label: "x",
      target: {
        origin: "http://localhost:1",
        local: true,
        version: "0.1.0",
        commit: null,
        baselineMs: 3,
      },
      profile: "smoke",
      seedScale: "legacy",
      scenarios: ["reports"],
      startedAt: "a",
      finishedAt: "b",
      durationMs: 1000,
      machine: { cpus: 4, loadavgStart: [1, 1, 1], loadavgEnd: [2, 2, 2], node: "v24" },
      signIns: { real: 1, refreshes: 0 },
      scenarioErrors: {},
      metrics: [],
      counters: { "export.files": 2 },
      budget: [],
      pass: true,
      disclaimer: "Tooling smoke results, not a capacity measurement.",
    } as unknown as RunResult;
    const markdown = renderMarkdown(result);
    expect(markdown).toContain("> **Tooling smoke results, not a capacity measurement.**");
    expect(markdown).toContain("| Result | **PASS** |");
    expect(markdown).toContain("| `export.files` | 2 |");
  });
});
