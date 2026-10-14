// Tests for the alerts-as-code (T-096). Run: node --test docs/runbooks/monitoring/alerts.test.mjs
// (CI: the "Backup self-test" job in .github/workflows/backup.yml).
//
// The point is drift: an alert that filters on an event or tag the code no longer emits, or links a
// runbook section that was renamed, silently never fires. These tests read the real sources.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  apply,
  cronCheckInUrl,
  cronMonitorPayload,
  issueRulePayload,
  loadAlerts,
  plannedRequests,
} from "./sentry-alerts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runbooks = join(here, "..");
const repo = join(here, "../../..");
const config = loadAlerts();
const allAlerts = [...config.issueAlerts, ...config.cronMonitors, ...config.uptimeChecks];

/** Non-test TypeScript under the given folders, concatenated. */
function sourceText(...dirs) {
  let text = "";
  for (const dir of dirs) {
    for (const entry of readdirSync(join(repo, dir), { recursive: true })) {
      const file = String(entry);
      if (!file.endsWith(".ts") || /\.test\.ts$|\.isolation\.ts$|test-support|testing\//.test(file)) {
        continue;
      }
      text += `${readFileSync(join(repo, dir, file), "utf8")}\n`;
    }
  }
  return text;
}
const source = sourceText("apps/web/src", "packages/core/src");

/** GitHub's heading anchors: lower case, drop punctuation (keep letters, digits, _ and -), spaces → -. */
function anchors(markdown) {
  return new Set(
    markdown
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#{1,6} /, "")
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_\- ]/gu, "")
          .replace(/ /g, "-"),
      ),
  );
}

describe("alerts.json", () => {
  it("has unique ids and a severity in every name", () => {
    const ids = allAlerts.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const alert of allAlerts) {
      assert.match(alert.severity, /^P[123]$/, alert.id);
      assert.ok(alert.name.startsWith(`[${alert.severity}] `), `${alert.id}: name starts with [${alert.severity}]`);
      assert.ok(alert.why.length > 20, `${alert.id}: says why`);
    }
  });

  it("links runbook sections that exist", () => {
    for (const alert of allAlerts) {
      const [file, anchor] = alert.runbook.split("#");
      const path = join(runbooks, file);
      assert.ok(existsSync(path), `${alert.id}: ${file} exists`);
      assert.ok(anchor, `${alert.id}: links a section, not just a file`);
      assert.ok(
        anchors(readFileSync(path, "utf8")).has(anchor),
        `${alert.id}: #${anchor} is a heading in ${file}`,
      );
    }
  });

  it("is listed in monitoring.md's alert table", () => {
    const doc = readFileSync(join(runbooks, "monitoring.md"), "utf8");
    for (const alert of allAlerts) assert.ok(doc.includes(`\`${alert.id}\``), `${alert.id} in monitoring.md`);
  });
});

describe("runbooks", () => {
  it("link only files and sections that exist", () => {
    const problems = [];
    for (const name of readdirSync(runbooks).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(runbooks, name), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target)) continue; // http(s):, mailto:
        const [file, anchor] = target.split("#");
        const path = file ? join(runbooks, file) : join(runbooks, name);
        if (!existsSync(path)) {
          problems.push(`${name}: ${target} (no such file)`);
        } else if (anchor && path.endsWith(".md") && !anchors(readFileSync(path, "utf8")).has(anchor)) {
          problems.push(`${name}: ${target} (no such section)`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe("alerts match what the code emits", () => {
  it("filters only on messages the code captures", () => {
    for (const alert of config.issueAlerts) {
      if (!alert.when.message) continue;
      assert.ok(source.includes(`"${alert.when.message}"`), `${alert.id}: "${alert.when.message}" is in the code`);
    }
  });

  it("filters only on tags the code sets, with values the code uses", () => {
    // T-043: the job-failure capture tags job_type and reason.
    assert.match(source, /tags: \{ job_type: failure\.type, reason: failure\.reason \}/);
    for (const alert of config.issueAlerts) {
      const tags = { ...alert.when.tags, ...alert.when.tagsNot };
      for (const [key, raw] of Object.entries(tags)) {
        for (const value of [raw].flat()) {
          if (value === "*") {
            assert.match(source, new RegExp(`tags: \\{ ${key}: `), `${alert.id}: a capture sets tag ${key}`);
          } else if (key === "job_type") {
            assert.ok(source.includes(`type: "${value}"`), `${alert.id}: job type ${value} is defined`);
          } else {
            assert.ok(source.includes(`${key}: "${value}"`), `${alert.id}: tag ${key}=${value} is set`);
          }
        }
      }
    }
  });

  it("checks a health route that exists", () => {
    for (const check of config.uptimeChecks) {
      assert.ok(existsSync(join(repo, check.route)), check.route);
    }
  });

  it("monitors the backup on the workflow's own schedule", () => {
    const workflow = readFileSync(join(repo, ".github/workflows/backup.yml"), "utf8");
    for (const monitor of config.cronMonitors) {
      assert.ok(workflow.includes(`cron: "${monitor.schedule}"`), `${monitor.slug}: schedule in backup.yml`);
      assert.ok(
        workflow.includes(`github.event.schedule == '${monitor.schedule}'`),
        `${monitor.slug}: the backup job runs on that schedule`,
      );
      assert.ok(workflow.includes("BACKUP_SENTRY_CRON_URL"), "backup.yml checks in");
      assert.ok(monitor.maxRuntimeMinutes >= 60, "max runtime covers the job's timeout");
    }
  });
});

describe("Sentry payloads", () => {
  it("builds the bill-run alert: every job.failed event with job_type billing.run, by email", () => {
    const alert = config.issueAlerts.find((a) => a.id === "billing-run-failed");
    assert.deepEqual(issueRulePayload(alert, "production"), {
      name: "[P1] Bill run job failed",
      environment: "production",
      actionMatch: "any",
      filterMatch: "all",
      frequency: 30,
      conditions: [
        { id: "sentry.rules.conditions.event_frequency.EventFrequencyCondition", value: 0, interval: "1m" },
      ],
      filters: [
        {
          id: "sentry.rules.filters.event_attribute.EventAttributeFilter",
          attribute: "message",
          match: "eq",
          value: "job.failed",
        },
        { id: "sentry.rules.filters.tagged_event.TaggedEventFilter", key: "job_type", match: "eq", value: "billing.run" },
      ],
      actions: [
        { id: "sentry.mail.actions.NotifyEmailAction", targetType: "IssueOwners", fallthroughType: "ActiveMembers" },
      ],
    });
  });

  it("excludes the job types that have their own alert from the catch-all", () => {
    const alert = config.issueAlerts.find((a) => a.id === "job-failed-any");
    const ne = issueRulePayload(alert, "production").filters.filter((f) => f.match === "ne");
    assert.deepEqual(
      ne.map((f) => f.value),
      ["billing.run", "invariants.check"],
    );
  });

  it("uses thresholds for the sync spike and 'is set' for any cron", () => {
    const spike = issueRulePayload(config.issueAlerts.find((a) => a.id === "sync-errors-spike"), "production");
    assert.deepEqual(spike.conditions[0], {
      id: "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
      value: 10,
      interval: "1h",
    });
    const cron = issueRulePayload(config.issueAlerts.find((a) => a.id === "cron-failed"), "production");
    assert.deepEqual(cron.filters, [{ id: "sentry.rules.filters.tagged_event.TaggedEventFilter", key: "cron", match: "is" }]);
  });

  it("builds every planned request, and a cron monitor on UTC", () => {
    const requests = plannedRequests(config, { org: "acme" });
    assert.equal(requests.length, config.issueAlerts.length + config.cronMonitors.length);
    for (const req of requests) assert.ok(req.body.name, req.key);
    assert.deepEqual(cronMonitorPayload(config.cronMonitors[0], "cable-billing-web").config, {
      schedule_type: "crontab",
      schedule: "0 20 * * *",
      timezone: "UTC",
      checkin_margin: 60,
      max_runtime: 60,
      failure_issue_threshold: 1,
      recovery_threshold: 1,
    });
  });

  it("derives the check-in URL from a DSN", () => {
    assert.equal(
      cronCheckInUrl("https://abc123@o42.ingest.us.sentry.io/4507", "nightly-backup"),
      "https://o42.ingest.us.sentry.io/api/4507/cron/nightly-backup/abc123/",
    );
    assert.throws(() => cronCheckInUrl("https://example.com/x", "nightly-backup"));
  });

  it("--apply creates what is missing and updates what exists, by name or slug", async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ method: init.method, path: new URL(url).pathname, auth: init.headers.Authorization });
      const path = new URL(url).pathname;
      if (init.method === "GET" && path.endsWith("/rules/")) {
        return new Response(JSON.stringify([{ id: "7", name: "[P1] Bill run job failed" }]));
      }
      if (init.method === "GET" && path.includes("/monitors/")) return new Response("", { status: 404 });
      return new Response("{}", { status: 201 });
    };
    const lines = await apply(config, {
      org: "acme",
      project: "cable-billing-web",
      api: "https://sentry.example",
      token: "t0ken",
      fetchImpl: fakeFetch,
    });
    assert.ok(lines.includes('updated issue alert "[P1] Bill run job failed"'));
    assert.ok(lines.includes('created issue alert "[P1] Payment sync errors spike"'));
    assert.ok(lines.includes("created cron monitor nightly-backup"));
    assert.ok(calls.some((c) => c.method === "PUT" && c.path === "/api/0/projects/acme/cable-billing-web/rules/7/"));
    assert.ok(calls.some((c) => c.method === "POST" && c.path === "/api/0/organizations/acme/monitors/"));
    assert.ok(calls.every((c) => c.auth === "Bearer t0ken"));
  });
});
