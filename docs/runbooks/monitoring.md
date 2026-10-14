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
| `cron-billing-scheduler` | P1 | Sentry **cron monitor**, checked in by `/api/cron/billing-scheduler` | no check-in by 19:15 UTC (00:45 IST), a run over 6 min, or an error answer | [§8 below](#8-a-cron-missed-a-run-or-reported-an-error) |
| `cron-job-worker` | P1 | cron monitor, `/api/cron/job-worker` | 3 runs in a row missed (2 min margin), over 6 min, or failed | [§8 below](#8-a-cron-missed-a-run-or-reported-an-error) |
| `cron-invariants` | P2 | cron monitor, `/api/cron/invariants` | no check-in by 21:30 UTC (03:00 IST), or an error | [§8 below](#8-a-cron-missed-a-run-or-reported-an-error) |
| `cron-subscription-states` | P2 | cron monitor, `/api/cron/subscription-states` | no check-in by 01:00 UTC (06:30 IST), or an error | [§8 below](#8-a-cron-missed-a-run-or-reported-an-error) |
| `health` | P1 | **uptime check** on `/api/health` (DB `select 1`, 2 s timeout) | 3 failed checks in a row (not 200, or no answer in 10 s); 503 = database not answering | [§5 below](#5-site-down) |

Alerts that exist without Sentry (already built):

- **Job-failure emails** (T-043): every failed job emails the active platform admins (and, for tenant
  jobs, that tenant's Owners in plain words). These work as soon as `RESEND_API_KEY` is set, even
  before any Sentry rule exists.
- **GitHub** emails the last editor of `backup.yml` when a scheduled run fails.
- **Razorpay** shows failed webhook deliveries in its dashboard (and retries them).

### Database health and cron check-ins (T-096a)

- `/api/health` runs `select 1` (read-only, as `app_platform`, no table read) through its own small
  pool with a **2 s** timeout. Database up: `200`, `"db":{"status":"ok"}`. Refused, failing or
  slower than 2 s: `503`, `"status":"degraded"`, `"db":{"status":"error"}`. The body never carries
  the error, the host or a timing. Concurrent requests share one ping, so a burst of calls costs
  one query.
- The Vercel crons in the table above check in with their Sentry cron monitor (`in_progress`, then
  `ok` for a 2xx answer or `error` otherwise) **only when `SENTRY_DSN` is set**; without it nothing
  is sent. A call that fails the `CRON_SECRET` check never checks in. Sentry being down or slow never
  changes a cron's answer: check-ins are fire-and-forget, the final flush waits at most ~2.5 s, and
  a failure is logged as `cron.check_in_failed` / `cron.check_in_not_flushed`.
- The monitors (schedule, margin, max runtime, failure threshold) are defined only in `alerts.json`;
  check-ins carry just the slug, so **run `sentry-alerts.mjs --apply` before relying on them** (§2).
  `alerts.test.mjs` fails if a monitor's schedule differs from `apps/web/vercel.json`, or if the
  monitored crons differ from `CRON_MONITORS` in `apps/web/src/app/api/cron/_lib/monitor.ts`.

### Known gaps

- Not monitored yet: `session-close` (still a 501 stub; add it to `CRON_MONITORS` and `alerts.json`
  when T-062a lands) and the weekly `receipt-links-cleanup` (housekeeping; a crash still raises
  `cron-failed`).
- Vercel runs crons on the **production** deployment only, so the monitors see the `production`
  environment. Previews never check in.
- None of this has been run against a real Sentry org (H-01): the check-in envelopes were checked
  with the SDK's own transport hook in tests, not received by Sentry.

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
6. Check it works: Sentry → Alerts lists the 8 rules; Crons lists `nightly-backup` and the four
   `cron-*` monitors. Trigger a test with Actions → Backup → Run workflow → `backup` and watch
   `nightly-backup` turn green. The `cron-*` monitors turn green on their own once production has
   `SENTRY_DSN` and the crons run (`cron-job-worker` within a few minutes of the deploy). On each
   monitor's page, check that its notifications reach the on-call people (Sentry decides that per
   monitor; the script does not set it).

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
   the database refused, failed or took over 2 s to answer `select 1` (Neon status page, Neon console: is the compute up, is the project suspended for
   billing?). `500` = the app fails at boot: Vercel → Deployments → latest → Runtime logs; an
   `EnvError` names the missing variable (environments.md §2).
2. Did a deploy just go out? Vercel → Deployments. If yes and the previous one was fine: **Instant
   Rollback** (rollback.md §1).
3. Vercel status page / Neon status page for a provider outage. During an outage the phones keep
   collecting and queue payments (nothing is lost; they sync later). Tell operators in plain words:
   "The office website is down; phones keep working. We will tell you when it is back."
4. After recovery: check crons ran (Vercel → Crons); if the bill scheduler's run at 00:15 IST was
   missed, the next run's catch-up handles it, or call it by hand (billing-run-failure.md §2).

## 6. Daily check (during hypercare after cutover, or while Sentry is not set up)

The cron monitors (§1) now raise a missed or failed cron on their own, once `SENTRY_DSN` is set and
`--apply` has created them. Until then, and every morning of hypercare, this check covers the same
ground. Two minutes each morning (IST). Read-only SQL on production, as the owner, from your machine
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

## 8. A cron missed a run or reported an error

Alerts `cron-billing-scheduler`, `cron-job-worker`, `cron-invariants`, `cron-subscription-states`
(Sentry → Crons). The monitor page says which kind: **missed** (no check-in in time), **timeout**
(`in_progress` for longer than 6 min: the function was killed at its 300 s limit) or **error** (the
route answered something other than 2xx).

1. **Error**: the same run usually also raised `cron-failed` with the exception (tag `cron=<name>`).
   Follow [billing-run-failure.md §2](billing-run-failure.md#2-a-cron-route-crashed) for that cron.
   An error without an exception is a non-2xx answer the route chose: find the request in the
   Vercel logs (`/api/cron/<name>`, `cron.finished` / `cron.failed` and its `request_id`).
2. **Missed**: nothing called the route, or it was refused before running.
   - Vercel → project → Settings → Cron Jobs: are crons enabled, and is the job listed with the
     schedule in `apps/web/vercel.json`? Was the latest production deploy missing it?
   - Vercel → Logs for `/api/cron/<name>`: `503 CRON_NOT_CONFIGURED` = `CRON_SECRET` missing in
     Production; `401` = Vercel and the project disagree on the secret (environments.md §6). Those
     calls never check in, so they show up here as missed.
   - Is the project paused, out of its plan's limits, or is Vercel having an incident (status page)?
   - Is `SENTRY_DSN` still set in Production? Without it nothing checks in and every monitor goes
     missed at once (all four `cron-*` monitors turning red together while the site is fine points
     here; `nightly-backup` checks in by URL and is not affected).
3. **Timeout**: the run hit the 300 s function limit. For `job-worker` that should not happen (it
   stops claiming at 240 s); look for a job type that does not yield (`continueLater`). For the
   others: logs for `cron.started` without `cron.finished`, and the database (Neon) being slow.
4. Once fixed, call the cron by hand if the missed run matters (each one is idempotent):
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<production>/api/cron/<name>`. The
   billing scheduler and books check catch up on their next run anyway; `job-worker` needs nothing:
   queued jobs wait, nothing is lost.
5. The monitor turns green on the next successful check-in (`recovery_threshold` 1).
