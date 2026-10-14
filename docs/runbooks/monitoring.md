# Runbook: monitoring and alerts

Who this is for: whoever sets up Sentry in H-01, and the engineer on call. PLAN §17 (observability),
PRD §11 ("alerting for failed billing, elevated sync failure and database/backup health"), E-08.

The alerts are **code**: [`monitoring/alerts.json`](monitoring/alerts.json). `sentry-alerts.mjs` turns
them into Sentry rules (dry run by default), and `alerts.test.mjs` fails CI when an alert names an
event or tag the code no longer emits, or links a runbook section that does not exist. Change an alert
in the JSON, never only in Sentry's UI (the next `--apply` would put it back).

---

## 1. What raises an alert

Severities: **P1** act now (any hour), **P2** same working day, **P3** next working day (README.md §2).

| Id | Severity | Signal (where it comes from) | Fires when | Runbook |
|---|---|---|---|---|
| `billing-run-failed` | P1 | Sentry message `job.failed`, tag `job_type=billing.run` (T-043 worker) | a tenant's bill run job failed after its retries | [billing-run-failure.md §1](billing-run-failure.md#1-a-bill-run-job-failed) |
| `invariant-breach` | P1 | `job.failed`, `job_type=invariants.check` (T-052) | the nightly books check found a breach or could not check a tenant | [invariant-breach.md](invariant-breach.md#what-to-do) |
| `job-failed-any` | P2 | `job.failed`, any other `job_type` | another background job failed | [billing-run-failure.md §3](billing-run-failure.md#3-another-background-job-failed) |
| `cron-failed` | P1 | Sentry exception tagged `cron=<name>` (`cronRoute`) | a cron route crashed (500) | [billing-run-failure.md §2](billing-run-failure.md#2-a-cron-route-crashed) |
| `sync-errors-spike` | P1 | Sentry exceptions tagged `endpoint=postPaymentBatch` | more than 10 in an hour | [stuck-sync.md §1](stuck-sync.md#1-server-side-errors-alert-payment-sync-errors-spike) |
| `razorpay-webhook-failed` | P2 | Sentry exception tagged `webhook=razorpay` | a signed webhook threw while being applied | [razorpay-webhooks.md](razorpay-webhooks.md#a-webhook-failed) |
| `unsafe-db-role` | P1 | Sentry message `Unsafe database runtime role` (boot check) | the app connects as a role that can bypass RLS | [environments.md §4.12](environments.md#412-runtime-database-role-cb_app-staging-and-production-after-the-first-migration) |
| `new-issue` | P3 | any new or regressed Sentry issue in `production` | a new kind of error | [§4 below](#4-triage-a-sentry-alert) |
| `nightly-backup` | P1 | Sentry **cron monitor**, checked in by `backup.yml` | no successful backup by 21:00 UTC, or it reported an error | [backup-and-restore.md §7](backup-and-restore.md#7-when-the-backup-alert-fires) |
| `health` | P1 | **uptime check** on `/api/health` | 3 failed checks in a row (not 200, or no answer in 10 s) | [§5 below](#5-site-down) |

Alerts that exist without Sentry (already built):

- **Job-failure emails** (T-043): every failed job emails the active platform admins (and, for tenant
  jobs, that tenant's Owners in plain words). These work as soon as `RESEND_API_KEY` is set, even
  before any Sentry rule exists.
- **GitHub** emails the last editor of `backup.yml` when a scheduled run fails.
- **Razorpay** shows failed webhook deliveries in its dashboard (and retries them).

### Known gaps (follow-up task T-096a)

- `/api/health` does not touch the database yet: its `db` check reports `not_configured` (T-005's
  placeholder), so the uptime check catches "site down" but not "database down". T-096a adds a
  `select 1` with a short timeout.
- The Vercel crons do not check in with Sentry, so a cron that **silently stops running** (cron
  disabled, project paused) raises nothing; only crashes do (`cron-failed`). T-096a wraps the cron
  routes in Sentry cron check-ins and adds monitors for `billing-scheduler`, `job-worker` and
  `invariants` to `alerts.json`. Until then the daily check in §6 covers it.

## 2. Setting up the Sentry side (H-01, after environments.md §4.3)

1. Dry run (no account needed) to see exactly what will be created:
   ```bash
   node docs/runbooks/monitoring/sentry-alerts.mjs
   ```
2. Create a Sentry **org auth token** (Settings → Auth Tokens) with `alerts:write`, `project:read`,
   `org:read`. Keep it in the password manager, not in a file.
3. Apply (creates or updates by name, so it is safe to re-run):
   ```bash
   read -rs SENTRY_AUTH_TOKEN && export SENTRY_AUTH_TOKEN
   SENTRY_ORG=<org slug> node docs/runbooks/monitoring/sentry-alerts.mjs --apply
   # EU-region org: SENTRY_API=https://de.sentry.io
   ```
   The script follows Sentry's documented API but has **not** been run against a real org yet. If
   Sentry answers 400, its message names the field; fix `issueRulePayload` / `cronMonitorPayload`,
   re-run the tests (`node --test docs/runbooks/monitoring/alerts.test.mjs`) and note it in this file.
4. Backup check-in URL: `SENTRY_DSN=<cable-billing-web DSN> node docs/runbooks/monitoring/sentry-alerts.mjs --cron-url`
   prints it; store it as the secret `BACKUP_SENTRY_CRON_URL` in the GitHub environment `backup`
   (backup-and-restore.md §6). The next nightly run checks in.
5. **Notifications**: the rules email the issue's owners, else every active member of the org. Keep
   the org small (the people who are on call). For P1 at night, each on-call person installs the
   Sentry mobile app and allows push notifications. Who else gets billing-failure alerts is open
   question Q-11 (default: platform admin + tenant Owner by email, which T-043 already does).
6. Check it works: Sentry → Alerts lists the 8 rules and the `nightly-backup` monitor; trigger a test
   with Actions → Backup → Run workflow → `backup` and watch the monitor turn green.

## 3. Uptime check (H-01, by hand)

Use Sentry's uptime monitoring (Alerts → Create Alert → Uptime monitor) or any external checker
(Better Stack, UptimeRobot); the settings are the `uptimeChecks` entry of `alerts.json`:

| Setting | Value |
|---|---|
| URL | `<production APP_BASE_URL>/api/health` (until H-02's domain: the Vercel production URL) |
| Method / expect | `GET`, status **200** (503 = degraded, also an alert) |
| Interval / timeout | 60 s / 10 s |
| Alert after | 3 failures in a row; notify the same people as P1 |
| Region | one in Asia (Singapore or Mumbai) if offered |

Production has no Vercel Deployment Protection, so the checker needs no bypass header. Do **not**
point an uptime check at a preview URL.

## 4. Triage a Sentry alert

1. Open the issue. Check **environment** (`production`?), **release** (which deploy), first/last seen
   and the event count. Events carry ids and codes only (we send no customer data, `lib/sentry.ts`).
2. Read the tags: `job_type`, `reason`, `cron`, `endpoint`, `webhook`. They say which runbook applies
   (table in §1).
3. Find the request in the Vercel runtime logs by time and `request_id` (JSON lines; `operator_id` is
   there too). Never paste log lines with customer data into Sentry, an issue or a chat.
4. Decide the severity (README.md §2). New issue that repeats every few minutes = treat as P2 at least.
5. Fix forward (PR) or roll back (rollback.md). Resolve the issue in Sentry when the fix is deployed,
   so a regression alerts again.

## 5. Site down

The uptime check failed three times.

1. Open `/api/health` yourself. `200` = a blip (note it). `503` with `"db":{"status":"error"}` =
   database (Neon status page, Neon console: is the compute up, is the project suspended for
   billing?). `500` = the app fails at boot: Vercel → Deployments → latest → Runtime logs; an
   `EnvError` names the missing variable (environments.md §2).
2. Did a deploy just go out? Vercel → Deployments. If yes and the previous one was fine: **Instant
   Rollback** (rollback.md §1).
3. Vercel status page / Neon status page for a provider outage. During an outage the phones keep
   collecting and queue payments (nothing is lost; they sync later). Tell operators in plain words:
   "The office website is down; phones keep working. We will tell you when it is back."
4. After recovery: check crons ran (Vercel → Crons); if the bill scheduler's run at 00:15 IST was
   missed, the next run's catch-up handles it, or call it by hand (billing-run-failure.md §2).

## 6. Daily check (until T-096a, and during hypercare after cutover)

Two minutes each morning (IST). Read-only SQL on production, as the owner, from your machine
(environments.md §4.12 for the URL; never a screenshot of results with names in it):

```sql
-- Crons alive? (job-worker runs every 2 min; invariants nightly)
SELECT type, status, count(*), max(finished_at) AS last_finished
FROM jobs WHERE created_at > now() - interval '2 days' GROUP BY 1, 2 ORDER BY 1, 2;
-- Anything stuck queued for over 30 minutes means job-worker is not running.
SELECT count(*) FROM jobs WHERE status = 'queued' AND run_after < now() - interval '30 minutes';
-- Last night's books check: one row per tenant, all 'ok'.
SELECT status, count(*), max(checked_at) FROM invariant_checks
WHERE checked_at > now() - interval '1 day' GROUP BY 1;
```

## 7. Operational metrics (PRD §16)

Until the admin console shows them (T-086), read them with SQL (counts only):

| Metric | Query sketch |
|---|---|
| Billing success rate (month P) | `SELECT sum(created_count + already_exists_count)::float / nullif(sum(customer_count - skipped_count), 0) FROM billing_runs WHERE period = 'P'` |
| Billing exception rate | `SELECT reason, count(*) FROM billing_run_items i JOIN billing_runs r ON r.id = i.run_id WHERE r.period = 'P' AND i.outcome = 'failed' GROUP BY 1` |
| Payment sync success / duplicates | Vercel logs: `mobile_api.payment_batch` lines carry `posted`, `posted_needs_review`, `duplicate`, `rejected`, `retry_later` counts per request |
| Payments needing review | `SELECT review_reason, count(*) FROM payments WHERE review_status = 'needs_review' GROUP BY 1` |
| Handover discrepancy rate | `SELECT count(*) FILTER (WHERE discrepancy_paise <> 0)::float / nullif(count(*) FILTER (WHERE discrepancy_paise IS NOT NULL), 0) FROM collection_sessions WHERE business_date >= current_date - 30` |
