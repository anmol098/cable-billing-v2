# Runbooks

What to do when something breaks, and how the safety nets (backups, alerts) are set up. Written for
the engineer on call; plain steps, real commands. PLAN §17, BRD §15 (Operational readiness), PRD §11.

| Runbook | Use it when |
|---|---|
| [environments.md](environments.md) | setting up accounts and secrets (H-01), rotating a secret, the `cb_app` database role |
| [monitoring.md](monitoring.md) | an alert fired and you don't know which runbook; setting up Sentry alerts and the uptime check; the daily check |
| [billing-run-failure.md](billing-run-failure.md) | a bill run or another background job failed; a cron route crashed |
| [invariant-breach.md](invariant-breach.md) | the nightly books check found numbers that don't add up |
| [stuck-sync.md](stuck-sync.md) | payments are stuck on linemen's phones, or the sync errors spike |
| [razorpay-webhooks.md](razorpay-webhooks.md) | subscription webhooks fail, or an operator paid but still shows unpaid |
| [support-access.md](support-access.md) | an operator asks for help with their data; the support-access policy |
| [backup-and-restore.md](backup-and-restore.md) | restoring data (Neon point-in-time or a nightly dump), the monthly restore drill, the backup alert |
| [restore-log.md](restore-log.md) | recording every drill and restore |
| [rollback.md](rollback.md) | undoing a deploy, a migration, an Android release or a config change |
| [cutover.md](cutover.md) | moving operators from the legacy system (H-09) |

Tooling next to them: [`backup/`](backup/) (backup, restore drill, self-test; run by
`.github/workflows/backup.yml`) and [`monitoring/`](monitoring/) (alerts as code + tests).
SQL helpers there use the `.pgsql` extension because the repository ignores `*.sql` outside
`packages/db` (a guard against committing legacy dumps).

---

## 1. Severity

| | Meaning | Examples | Response |
|---|---|---|---|
| **P1** | money, data or many users affected now | bill run failed, books breach, site down, sync errors spike, backup missing 2 nights | start within 30 minutes, any hour; tell the product owner |
| **P2** | one operator or a degraded feature; a safety net is weaker | one background job failed, one night's backup missed, webhook failing | same working day |
| **P3** | cosmetic or rare | a new error seen once | next working day |

Response times and who is on call are proposals until the product owner agrees the support SLA (BRD
§16 "Support SLA and incident ownership", PLAN Q-11).

## 2. Running an incident

1. **Say it**: one message in the team channel: what is broken, since when, severity, who leads.
2. **Stop the harm** before finding the cause: roll back a bad deploy (rollback.md §1), pause what is
   writing bad data. Phones keep payments safe while the server is down; don't ask anyone to delete or
   reinstall anything.
3. **Follow the runbook** for the alert. Keep a short incident note (times in IST, what you saw, what
   you did): a private doc or ticket, **never** with customer names, phone numbers or amounts per
   customer; ids only.
4. **Tell operators** when they are affected, in plain words, and never claim something was "sent" or
   "delivered" that we can't see (only "opened"/"shared", CLAUDE.md).
5. **Close**: what happened, why, what changed so it doesn't recur (a test, an alert, a runbook fix).
   If a runbook was wrong, fix it in the same week.

## 3. Ground rules (every runbook)

- Financial records are append-only: corrections are reversals and adjustments made in the app, never
  `UPDATE`/`DELETE` (CLAUDE.md). Never switch triggers off in production.
- Production database access is break-glass (support-access.md §3): read-only, ids in notes.
- Secrets live in Vercel, GitHub environments and the password manager only (environments.md).
- Every job, cron and webhook is idempotent: calling it again is the normal way to retry.
