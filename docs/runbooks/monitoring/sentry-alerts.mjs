#!/usr/bin/env node
/**
 * Applies docs/runbooks/monitoring/alerts.json to Sentry (T-096). DRY RUN BY DEFAULT: prints the
 * API requests it would send and touches nothing.
 *
 *   node docs/runbooks/monitoring/sentry-alerts.mjs            # dry run, no credentials needed
 *   node docs/runbooks/monitoring/sentry-alerts.mjs --apply    # create or update, by name / slug
 *   node docs/runbooks/monitoring/sentry-alerts.mjs --cron-url # print the backup check-in URL
 *
 * Cron monitors: `nightly-backup` checks in from backup.yml through its URL (--cron-url); the
 * `cron-*` monitors are the Vercel crons, which check in through the server SDK when SENTRY_DSN is
 * set (apps/web/src/app/api/cron/_lib/monitor.ts, T-096a). Their check-ins carry only the slug, so
 * the monitors must exist: run --apply before (or right after) the first production deploy.
 *
 * --apply needs SENTRY_AUTH_TOKEN (org token or a user token with alerts:write, project:read,
 * org:read), SENTRY_ORG, and optionally SENTRY_PROJECT (default from alerts.json) and SENTRY_API
 * (default https://sentry.io; EU orgs: https://de.sentry.io). --cron-url needs SENTRY_DSN.
 * The token is sent only to SENTRY_API and is never printed.
 *
 * Status: written against Sentry's documented REST API (issue alert rules, cron monitors); it has
 * NOT been run against a real Sentry org yet (none exists before H-01). Uptime checks are set up by
 * hand (docs/runbooks/monitoring.md §3), because their API is not stable enough to script blind.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadAlerts(path = join(here, "alerts.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const EMAIL_ACTION = {
  id: "sentry.mail.actions.NotifyEmailAction",
  targetType: "IssueOwners",
  fallthroughType: "ActiveMembers",
};

/** One issue alert from alerts.json → the body of POST /projects/{org}/{project}/rules/. */
export function issueRulePayload(alert, environment) {
  const { when } = alert;
  const conditions = [];
  if (when.firstSeenOrRegression) {
    conditions.push({ id: "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition" });
    conditions.push({ id: "sentry.rules.conditions.regression_event.RegressionEventCondition" });
  } else if (when.everyEvent) {
    // Events of one kind group into one issue; "seen more than 0 times in 1 minute" fires on each
    // new event (throttled by `frequency`), unlike "first seen", which fires only once per issue.
    conditions.push({
      id: "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
      value: 0,
      interval: "1m",
    });
  } else if (when.moreThan !== undefined) {
    conditions.push({
      id: "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
      value: when.moreThan,
      interval: when.interval,
    });
  } else {
    throw new Error(`alert ${alert.id}: no condition`);
  }

  const filters = [];
  if (when.message) {
    filters.push({
      id: "sentry.rules.filters.event_attribute.EventAttributeFilter",
      attribute: "message",
      match: "eq",
      value: when.message,
    });
  }
  for (const [key, value] of Object.entries(when.tags ?? {})) {
    filters.push(
      value === "*"
        ? { id: "sentry.rules.filters.tagged_event.TaggedEventFilter", key, match: "is" }
        : { id: "sentry.rules.filters.tagged_event.TaggedEventFilter", key, match: "eq", value },
    );
  }
  for (const [key, values] of Object.entries(when.tagsNot ?? {})) {
    for (const value of values) {
      filters.push({ id: "sentry.rules.filters.tagged_event.TaggedEventFilter", key, match: "ne", value });
    }
  }

  return {
    name: alert.name,
    environment,
    actionMatch: "any",
    filterMatch: "all",
    // Minutes between two notifications for the same issue.
    frequency: alert.severity === "P3" ? 1440 : 30,
    conditions,
    filters,
    actions: [EMAIL_ACTION],
  };
}

/** One cron monitor → the body of POST /organizations/{org}/monitors/. */
export function cronMonitorPayload(monitor, project) {
  return {
    project,
    name: monitor.name,
    slug: monitor.slug,
    type: "cron_job",
    config: {
      schedule_type: "crontab",
      schedule: monitor.schedule,
      timezone: "UTC",
      checkin_margin: monitor.checkinMarginMinutes,
      max_runtime: monitor.maxRuntimeMinutes,
      // Consecutive missed/failed check-ins before Sentry opens an issue (job-worker: 3, a blip of
      // one 2-minute run is not worth waking anyone).
      failure_issue_threshold: monitor.failureIssueThreshold ?? 1,
      recovery_threshold: 1,
    },
  };
}

/**
 * The HTTP check-in URL for a cron monitor, from the project's DSN
 * (`https://<key>@o<org>.ingest.<region>.sentry.io/<project id>`). backup.yml appends ?status=….
 */
export function cronCheckInUrl(dsn, slug) {
  const url = new URL(dsn);
  const key = url.username;
  const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!key || !/^\d+$/.test(projectId)) throw new Error("SENTRY_DSN does not look like a Sentry DSN");
  return `${url.protocol}//${url.host}/api/${projectId}/cron/${slug}/${key}/`;
}

/** Everything --apply would send, in order (pure: tests and the dry run use it). */
export function plannedRequests(config, { org, project = config.sentry.project }) {
  const environment = config.sentry.environment;
  return [
    ...config.issueAlerts.map((alert) => ({
      kind: "issue-alert",
      key: alert.name,
      list: `/api/0/projects/${org}/${project}/rules/`,
      body: issueRulePayload(alert, environment),
    })),
    ...config.cronMonitors.map((monitor) => ({
      kind: "cron-monitor",
      key: monitor.slug,
      list: `/api/0/organizations/${org}/monitors/`,
      body: cronMonitorPayload(monitor, project),
    })),
  ];
}

async function sentry(fetchImpl, api, token, method, path, body) {
  const res = await fetchImpl(new URL(path, api), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 404) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Create or update every rule and monitor. Returns one line per item. */
export async function apply(config, { org, project, api, token, fetchImpl = fetch }) {
  const out = [];
  for (const req of plannedRequests(config, { org, project })) {
    if (req.kind === "issue-alert") {
      const { json: rules } = await sentry(fetchImpl, api, token, "GET", req.list);
      const existing = (rules ?? []).find((rule) => rule.name === req.key);
      if (existing) {
        await sentry(fetchImpl, api, token, "PUT", `${req.list}${existing.id}/`, req.body);
        out.push(`updated issue alert "${req.key}"`);
      } else {
        await sentry(fetchImpl, api, token, "POST", req.list, req.body);
        out.push(`created issue alert "${req.key}"`);
      }
    } else {
      const { status } = await sentry(fetchImpl, api, token, "GET", `${req.list}${req.key}/`);
      if (status === 404) {
        await sentry(fetchImpl, api, token, "POST", req.list, req.body);
        out.push(`created cron monitor ${req.key}`);
      } else {
        await sentry(fetchImpl, api, token, "PUT", `${req.list}${req.key}/`, req.body);
        out.push(`updated cron monitor ${req.key}`);
      }
    }
  }
  return out;
}

async function main(argv) {
  const config = loadAlerts();
  if (argv.includes("--cron-url")) {
    if (!process.env.SENTRY_DSN) throw new Error("set SENTRY_DSN (Sentry → project → Client Keys)");
    // Only the GitHub workflow needs a URL; the Vercel crons check in through the SDK (SENTRY_DSN).
    for (const monitor of config.cronMonitors.filter((m) => m.workflow)) {
      console.log(`${monitor.slug}: ${cronCheckInUrl(process.env.SENTRY_DSN, monitor.slug)}`);
    }
    return;
  }
  const org = process.env.SENTRY_ORG ?? "<SENTRY_ORG>";
  const project = process.env.SENTRY_PROJECT ?? config.sentry.project;
  if (!argv.includes("--apply")) {
    console.log("DRY RUN (nothing is sent). Add --apply to create/update these in Sentry.\n");
    for (const req of plannedRequests(config, { org, project })) {
      console.log(`# ${req.kind} "${req.key}": upsert via ${req.list}`);
      console.log(JSON.stringify(req.body, null, 2));
    }
    console.log("\nUptime checks to create by hand (docs/runbooks/monitoring.md §3):");
    for (const check of config.uptimeChecks) {
      console.log(
        `- ${check.name}: GET <production APP_BASE_URL>${check.path} every ${check.intervalSeconds} s, timeout ${check.timeoutSeconds} s, alert after ${check.failuresBeforeAlert} failures`,
      );
    }
    return;
  }
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token || !process.env.SENTRY_ORG) throw new Error("--apply needs SENTRY_AUTH_TOKEN and SENTRY_ORG");
  const api = process.env.SENTRY_API ?? "https://sentry.io";
  for (const line of await apply(config, { org, project, api, token })) console.log(line);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`sentry-alerts: ${error.message}`);
    process.exitCode = 1;
  });
}
