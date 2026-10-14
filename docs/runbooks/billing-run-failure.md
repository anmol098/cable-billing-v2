# Runbook: bill run and background job failures

Alerts: `billing-run-failed`, `cron-failed`, `job-failed-any` (monitoring.md §1). Background:
PLAN §8.2 and §14, T-043 (job queue), T-044 (bill runs), D-13 / D-25 (read-only tenants, missed runs).

**Rules that never change:** issued invoices, payments, allocations and ledger entries are
append-only. Never `UPDATE`/`DELETE` them, and never hand-insert an invoice. Every fix below goes
through the app's own services (the Owner's buttons, or the crons), which are idempotent: running a
bill run twice never makes a second bill (RULE-05, PRD §15 #4).

How a month's bills are made, in one paragraph: at **00:15 IST** every day the `billing-scheduler`
cron creates (on the 1st) or catches up (other days) one `billing_runs` row per active tenant and
queues a `billing.run` job. `job-worker` (every 2 minutes) runs the job in slices of 200 customers,
one transaction per customer. A customer that can't be billed becomes a `failed` **item** (the run
still finishes, as `completed_with_errors`). A run whose **job** keeps crashing is retried with backoff
5 times and then the job is `failed`, which sends the alert, emails the platform admins and the
tenant's Owners, and leaves the run `pending`/`running`/`failed`.

---

## 1. A bill run job failed

Alert `[P1] Bill run job failed` (Sentry tags: `job_type=billing.run`, `reason`), plus the T-043 email
with the job id and tenant id.

1. **Find the job and the run** (read-only SQL, owner URL from the password manager):
   ```sql
   SELECT id, operator_id, status, attempts, max_attempts, last_error, payload, finished_at
   FROM jobs WHERE type = 'billing.run' AND status = 'failed' ORDER BY finished_at DESC LIMIT 10;
   -- payload holds runId and period:
   SELECT id, period, trigger, status, customer_count, created_count, already_exists_count,
          skipped_count, failed_count, started_at, finished_at
   FROM billing_runs WHERE id = '<payload.runId>';
   ```
2. **Read `last_error`** (`jobErrorSummary`: an error type, a SQLSTATE/constraint, or
   `permanent: <code>`; never customer data). Typical causes:
   - `max_attempts: … connection …` / `57P01` / timeouts: Neon was unreachable or restarting. Check
     the Neon status page. Nothing is wrong with the data; go to step 3.
   - `lease_expired`: the worker kept dying mid-slice (Vercel function time limit or a crash). Look
     for `job.lease_lost` / `cron.failed` in the Vercel logs around those times.
   - `permanent: invalid_payload` / `scope_mismatch`: a code bug (a deploy changed the payload
     schema). Fix forward; then step 3.
   - a constraint name: a code or data bug. Do not retry blindly; open an incident (README.md §2).
3. **Run it again** (safe and idempotent; customers already billed are skipped):
   - **Wait for the scheduler**: at the next 00:15 IST the scheduler re-queues `failed` runs and lost
     jobs on its own (T-044 "pending/running without a live job → re-queue; failed → pending + job").
   - **Now**: call the scheduler by hand (CRON_SECRET from the password manager), then the worker:
     ```bash
     curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<production host>/api/cron/billing-scheduler
     curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<production host>/api/cron/job-worker
     ```
     The scheduler's JSON report lists each tenant's outcome; `job-worker` reports `claimed`,
     `succeeded`, `continued` (a long run continues on the next 2-minute tick).
   - Or the tenant's Owner presses **Make bills** on Bills → Runs (`/bills/runs`, T-047) for that month.
   - The admin console's job monitor (T-086) will offer "retry" for failed jobs: it re-queues a new
     job; the failed row stays as history.
4. **Check the result**: `billing_runs.status` becomes `completed` or `completed_with_errors`;
   `failed_count` items are handled in §1.1.
5. **Tell the Owner** if bills were late: plain words, e.g. "Your November bills were made at 10:40.
   Nothing was charged twice." (T-043 already emailed them that something went wrong.)

### 1.1 The run finished, but some customers failed (`completed_with_errors`)

No alert fires for this (the job succeeded); the Owner sees it on Bills → Runs → the run (customers with a problem).

```sql
SELECT outcome, reason, count(*) FROM billing_run_items
WHERE run_id = '<run id>' GROUP BY 1, 2 ORDER BY 3 DESC;
```

| `reason` | Meaning | What to do |
|---|---|---|
| `balance_mismatch`, `credit_mismatch` | the customer's balance row disagrees with the ledger; the run refused to bill on a wrong opening balance | invariant-breach.md: find why the books drifted; after the fix, the Owner presses **Try problems again** |
| `internal_error` (`details.errorType`, `sqlstate`) | an unexpected error for that customer | a bug: incident + fix; then **Try problems again** |
| T-040 validation reasons (`invalid_transition`, `event_before_start`, …) | the customer's connection history doesn't make sense for that month | the Owner corrects the connection dates (Customers → the customer → Connections), then **Try problems again** |

**Try problems again** (`retryFailedItems`, Owner only, T-047) re-runs only the failed items.

### 1.2 Things that look like failures but are not

- Run `skipped` with `skip_reason = tenant_read_only`: the tenant's subscription lapsed (D-13). It is
  never billed automatically, even after they pay (D-25): it appears as a **missed bill run** for the
  Owner to preview and run.
- Customers `skipped` with `nothing_to_bill` (no active connection that month).
- A tenant created during the month gets no automatic run for that month (T-044 decision 5).

## 2. A cron route crashed

Alert `[P1] Cron route crashed` (Sentry tag `cron=<name>`): the route itself threw and answered 500.
Vercel does not retry crons.

1. Vercel → project → Logs, filter the path `/api/cron/<name>`, find `cron.failed` and its `request_id`.
2. By cron:
   - `billing_scheduler`: some tenants may have no run or job for today. The report (500 after the
     others finished) lists the failed tenants (`billing.schedule_tenant_failed`). Fix the cause, then
     call it by hand (§1 step 3). It is idempotent.
   - `job_worker`: nothing moves until it works. Jobs stay queued; nothing is lost. A crash on every
     tick is P1: check `DATABASE_URL`, Neon, and the last deploy (rollback.md §1).
   - `invariants`: the check was not queued tonight; call it by hand after the fix.
   - `subscription_states`: subscription dates are applied a day late at worst; call it by hand.
3. `503 CRON_NOT_CONFIGURED` in the logs (not an alert): `CRON_SECRET` is missing in Production
   (environments.md §6). `401`: Vercel and the project disagree on the secret; redeploy after setting it.

## 3. Another background job failed

Alert `[P2] Background job failed`: `job.failed` with any other `job_type`. Same steps as §1 1–2,
filtering `jobs.type`. Every job is idempotent by contract (T-043), so after fixing the cause:

- the scheduler-style crons re-queue their own work on their next run (`subscription-states` daily,
  `invariants` nightly, `receipt-links-cleanup` weekly);
- otherwise call the matching cron by hand (§1 step 3) or, after T-086, use the admin job monitor.

`job.alert_send_failed` / `job.alert_no_recipients` in the logs mean the email part failed (Resend
key, no active platform admin with an email): fix that too, or the next failure is silent by email.
