# Performance budget and load testing (T-095)

| | |
|---|---|
| **Status** | Tooling built and proven end to end against `next start` + local Postgres with the T-036 `legacy` seed. **Capacity has not been measured yet**: that needs a Vercel preview + Neon branch (H-01). §6 has the local smoke output, which is *not* a capacity measurement. |
| **Tool** | `tools/load` (`@cb/load`), plain Node `fetch`, no load-testing framework. Run `pnpm load --help`. |
| **Gate** | `pnpm load run … --gate` exits 1 when any budget line fails; `summary.json` (schema `cb-load-result/1`) is what a CI job keeps. |
| **Source of the numbers** | PRD §11 (Performance, Scale), PRD Appendix A (legacy baseline), PLAN §10 (mobile sync), §14 (jobs). Numbers marked *proposed* are not in the PRD and need the product owner's OK. |

---

## 1. What is measured

Six scenarios, run in this order (the order of a business day). Every scenario signs its users in
first, then starts them **at the same moment**, because the bursts are what hurt.

| Scenario | Who | What it does | Writes? |
|---|---|---|---|
| `billing` | the crons | `GET /api/cron/billing-scheduler` queues the month's run per tenant, then `GET /api/cron/job-worker` until the queue is empty and the scheduler reports every run `done` (PLAN §14; T-044). Times the whole run and every worker invocation. | bills |
| `sync` | lineman phones | **Morning burst**: `/app/config`, full roster sync in pages of 500 (`/sync/customers`), then rounds of "open a customer" (`/customers/{id}`) + delta sync (T-060). | no |
| `counter` | Staff at the counter | `/payments/new`, then "Find customer" and "Save payment" through the page's own Server Actions (T-048), exactly as the browser calls them. | payments |
| `reports` | Owners and Staff | Every list and report page (Home, Customers + page 5, Payments, Check payments, Bills, Bill runs, Bill register, Linemen, the seven `/reports/*`, Audit for Owners), customer search by name / code / phone / Hindi, and one customer's profile, bills and payments. Each page is timed to its **last byte** (full server render). | no |
| `exports` | Owners | CSV downloads (T-082), biggest first: 31 days of payments, 12 months of bills, the customer list, … | no (audited) |
| `payments` | lineman phones | **Evening burst**: every phone pushes full batches of 50 payments at once (`/payments:batch`, T-061), re-sends its first batch as a phone whose answer got lost (every item must come back `duplicate`), pushes its receipt actions, reads its day totals and pulls a delta. | payments |

Payments are small whole-rupee amounts (₹100–₹500) for **active** customers only, cash or UPI, with
contract-valid ids, provisional references and timestamps, so every rejection is a real bug.
**Never point the tool at production** (set `LOAD_FORBIDDEN_HOSTS` to the production host; §4).

### Load shapes (`--profile`)

| Profile | Phones | Counter clerks | Office users | Owners exporting | Sign-ins | Use |
|---|---|---|---|---|---|---|
| `smoke` | 4 × (2 sync rounds, 1 × 10 payments) | 2 × 3 payments | 2 × 1 round | 2 × 2 files | 8 | proves the tooling; not a load |
| `legacy` | 60 × (5 sync rounds, 2 × 50 payments) | 8 × 10 payments | 16 × 3 rounds | 8 × 3 files | 76 | the legacy business (PRD Appendix A: 8 operators, 7,616 customers, 134 linemen) at its daily peaks: about half the linemen open the app in the same minute and push together in the evening |
| `10x` | 300 × (same) | 40 × 10 | 80 × 3 | 20 × 3 | 420 | ten times the legacy business (T-036 `10x`: 80 operators, 76,160 customers, 1,340 linemen) |

`pnpm load plan --profile <name>` prints the exact users and requests of a run without sending anything.
The users are the T-036 seed's logins (`seed-op05-staff1`, `seed-op05-lineman07` …), derived from the
seed's own plan, so the tool never guesses a login.

### Rate limits: respected, never bypassed

| Limit (server) | How the tool stays inside it |
|---|---|
| Sign-in: 100 per IP and 10 per account per 15 min (T-026, shared by web and phone) | Each user signs in **at most once per run**; a run may make at most `--max-sign-ins` real sign-ins (default 90, never more than 100). Sign-ins are cached in `tools/load/.cache/sessions.json` (git-ignored, mode 0600): web session cookies (30 days) and phone refresh tokens (180 days, rotated on use and saved at once). A run that needs more new sign-ins than allowed is **refused before any load is sent**. For `10x` (420 users), run `pnpm load warm --profile 10x …` once per 15 minutes until it reports none missing (5 calls), then `run`. |
| Phone token refresh: 600 per IP, 30 per install per 15 min (T-028) | At most 550 refreshes per run; a phone refreshes only when its 15-minute access token has less than a minute left (as the app does). |
| Exports: 30 per Owner per 15 min (T-082) | At most 25 files per Owner per run (checked). |

There is **no test bypass** in the app, and the tool does not spoof `X-Forwarded-For` (Vercel's edge
overwrites it anyway). A result that only passes with a weakened limit would prove nothing.

---

## 2. The budget

`tools/load/src/budget.ts` holds these rules; a test checks that every id below exists there and that
every rule there is listed here. A rule with a `*` metric is checked on **each** matching metric
(each page separately). Timings are wall time from sending the request to reading the last byte, as a
user in front of the screen sees it, so they **include the network** (see "baseline round trip" in §4).

| Id | Metric | Limit | Why this number |
|---|---|---|---|
| B-WEB-LIST | `web.page.*` p95 | 2 s | PRD §11: common list/search operations p95 < 2 s. Applies to every list and report page. |
| B-WEB-SEARCH | `web.search.*` p95 | 2 s | PRD §11 (customer search by name, code, phone, Hindi). |
| B-COUNTER-FIND | `counter.find_customer` p95 | 2 s | PRD §11 (the counter's search box). |
| B-COUNTER-SAVE | `counter.take_payment` p95 | 2 s | PRD §11 common operation; the customer is waiting at the counter (FR-013). |
| B-SYNC-PAGE | `mobile.sync.page` p95 | 2 s | PRD §11 list operation: one roster page of ≤ 500 customers (T-060). |
| B-SYNC-FULL | `mobile.sync.full` p95 | 10 s | Derived: the whole-tenant roster on app open (PLAN §10.3) is 2–3 pages at ~1,000–1,400 customers. |
| B-SYNC-BYTES | `mobile.sync.full` max bytes | 1 MiB | PLAN §10.3: the roster is under 1 MB gzipped at the known scale (low-bandwidth phones). |
| B-SYNC-DELTA | `mobile.sync.delta` p95 | 2 s | PRD §11 list operation (pull after every push, every 30 min). |
| B-MOBILE-DETAIL | `mobile.customer.detail` p95 | 2 s | PRD §11 common operation. |
| B-MOBILE-DAY | `mobile.collections.day` p95 | 2 s | PRD §11 common operation (the lineman's day). |
| B-RECEIPT-ACTIONS | `mobile.receipts.actions` p95 | 2 s | PRD §11 common operation (receipt-action outbox). |
| B-PAY-BATCH | `mobile.payments.batch` p95 | 10 s | Derived: a batch is up to 50 payments (PLAN §10.2); the server stops starting items after 30 s (T-061). 10 s keeps a 3× margin. |
| B-PAY-RETRY | `mobile.payments.retry_later` count | 0 | T-061: items the server could not start within its 30 s batch budget. None under budget load. |
| B-PAY-REJECTED | `mobile.payments.rejected` count | 0 | Every generated payment is valid. |
| B-PAY-IDEMPOTENT | `mobile.payments.replay_not_duplicate` count | 0 | FR-015 / T-061: a re-sent batch is answered `duplicate` for every item, under load too. |
| B-COUNTER-REFUSED | `counter.payments_refused` count | 0 | Every generated counter payment is valid. |
| B-EXPORT | `export.*` p95 | 60 s | *Proposed* (no PRD number): a whole CSV within 60 s; the route allows 300 s (T-082). |
| B-BILLING-RUN | `billing.run.wall` | 30 min (`legacy`), 5 h (`10x`) | *Proposed*: the 00:15 IST run (PLAN §14) is finished for every tenant within 30 minutes at legacy size, and before 05:15 IST at 10×, i.e. before linemen start their day. |
| B-BILLING-INVOCATION | `billing.worker` max | 300 s | Vercel `maxDuration` of `/api/cron/job-worker`; the worker's own budget is 240 s (T-043). |
| B-BILLING-FAILED | `billing.failed_jobs` count | 0 | T-043/T-044: no billing job fails under load (a failed job alerts the admin). |
| B-BILLING-DONE | `billing.runs_not_done` count | 0 | Every queued tenant run is `done` when the queue empties. |
| B-MONEY-ERRORS | `mobile.payments.batch` error rate | 0 % | A payment request never fails under budget load. |
| B-COUNTER-ERRORS | `counter.take_payment` error rate | 0 % | Same, for the counter. |
| B-ERRORS | every metric, error rate | ≤ 1 % | PRD §11 Reliability. |

Counts only count for scenarios that ran to the end; a scenario that stopped (e.g. no `CRON_SECRET`)
fails the run instead. A rule whose scenario did not run is reported as "not measured".

**Not in the budget (measured elsewhere):** Lighthouse page weight and scores (T-087 / T-087a, re-measure
on a preview), and the database-only query timings of T-033 (search < 300 ms on 10k customers) and
T-080 (dues ~100 ms at legacy size), which are the floor under the page rules.

---

## 3. Running it

```bash
pnpm load plan --profile legacy                         # who and what; sends nothing
pnpm load run --base-url http://localhost:3000          # smoke profile, every scenario
pnpm load run --base-url https://<preview> --profile legacy --gate   # CI-style: exit 1 on a failed rule
pnpm load run … --scenarios sync,payments               # a subset
pnpm load warm --base-url https://<preview> --profile 10x            # pre-sign-in, max 90 per call
pnpm load check tools/load/results/<run>/summary.json --gate         # re-check a stored result
```

| Option / variable | Meaning |
|---|---|
| `--base-url` / `LOAD_BASE_URL` | the target (origin only is used) |
| `--profile` | `smoke` (default), `legacy`, `10x` |
| `--seed-scale`, `--seed` | the T-036 seed on the target (default: the profile's scale, seed 1) |
| `--scenarios` | `billing,sync,counter,reports,exports,payments` or `all` (default) |
| `--gate` | exit 1 when a budget line fails or a scenario stops |
| `--out` | result folder (default `tools/load/results/<UTC time>-<profile>`, git-ignored) |
| `--max-sign-ins` | real sign-ins this call may make (0–100, default 90) |
| `--no-cache` | don't read or write the sign-in cache |
| `--billing-workers` | parallel `job-worker` calls (default 1; Vercel's every-2-minutes cron with a 240 s budget overlaps about 2) |
| `LOAD_PASSWORD` | the seeded users' password (default the seed's `seed-dev-password`) |
| `LOAD_CRON_SECRET` | the target's `CRON_SECRET`; only `billing` needs it |
| `LOAD_VERCEL_BYPASS_SECRET` | Vercel "Protection Bypass for Automation" secret (previews are behind Vercel Authentication) |
| `LOAD_FORBIDDEN_HOSTS` | comma-separated hosts the tool refuses: put the production host here, in every shell and CI environment that has the other secrets |

Exit codes: 0 ok · 1 budget failed (`--gate`) · 2 bad options or refused (sign-in budget, missing secret) · 3 target not ready (`/api/health` not 200 with `db: ok`).

**Output.** `summary.json` (everything: target, version and commit from `/api/health`, profile,
load-generator CPUs and load average, sign-ins used, per-metric count / errors / p50 / p90 / p95 / p99 /
max / bytes, counters, every budget line with limit, actual and status, `pass`) and `summary.md` (the
same as tables). A run against `localhost` or a private address is labelled "tooling smoke … not a
capacity measurement" in both files.

**Before every run** the tool checks `/api/health` (200 and `db: ok`, else exit 3) and records the
fastest of five health round trips as the **baseline**: every timing includes at least this much
network. From a GitHub-hosted runner (US/EU) to Singapore that is ~200–250 ms per request; for numbers
that match what an operator in India sees, run from a machine in India or Singapore, or read the p95s
with the baseline in mind.

---

## 4. Runbook: a capacity run on a Vercel preview + Neon branch (needs H-01)

Everything here is non-production: the non-prod Neon project and a Vercel preview. **Never** run the
tool, or the seed, against production; the seed refuses a database with data and `VERCEL_ENV=production`.

1. **Make a preview with its own database.** Push any branch, e.g. `git push origin feature/mvp:load/2026-11-01`.
   Vercel builds a preview, and the Neon integration creates the branch `preview/load/2026-11-01` as a
   copy of `staging` (docs/runbooks/environments.md §1, §4.2).
2. **Give that database the legacy-size seed**, with **last month** as "today" so the current month is
   not billed yet (the `billing` scenario bills it):
   ```bash
   # The preview branch's direct (owner) URL from Neon → Connect. It is a copy of seed data only.
   # Drop and re-create its database first (it holds staging's small seed; the seed refuses a non-empty database).
   DATABASE_URL_UNPOOLED='postgres://…' pnpm db:seed --migrate --allow-remote --scale legacy --as-of <last day of last month>
   ```
   `--scale 10x` for the 10× run (expect ~10× the legacy time). After `--migrate`, re-check the
   `cb_app` role grants (environments.md §4.12) if the preview uses it.
3. **Preview settings** (Vercel → Settings → Environment Variables → Preview, scoped to the `load/…` git
   branch), then redeploy the preview:
   - `CRON_SECRET`: any long random value; the tool gets the same value as `LOAD_CRON_SECRET`. (Vercel
     does not run crons on previews; the `billing` scenario calls them by hand, like production's cron.)
   - `UPSTASH_REDIS_REST_URL` / `_TOKEN` of the **non-prod** Upstash database, so rate limits behave as
     in production (without them each function instance limits on its own).
   - For production-like numbers, `DATABASE_URL` = the branch's **pooled** URL with the `cb_app` role
     (§4.12), as production uses; the integration's default is the owner role.
   - Note the "Protection Bypass for Automation" secret (environments.md §3, `VERCEL_AUTOMATION_BYPASS_SECRET`).
   - Vercel Firewall: make sure attack-challenge mode is off for the preview, or the burst gets challenged.
4. **Run** from a machine near Singapore if you can (see the baseline note in §3):
   ```bash
   export LOAD_BASE_URL=https://<project>-git-load-2026-11-01-<team>.vercel.app
   export LOAD_CRON_SECRET=… LOAD_VERCEL_BYPASS_SECRET=… LOAD_FORBIDDEN_HOSTS=<production host>
   pnpm load run --profile smoke --scenarios sync,reports     # 30 s check that everything answers
   pnpm load run --profile legacy --gate                       # the measurement (one-shot: billing bills the month)
   ```
   For `10x`: seed `--scale 10x`, then `pnpm load warm --profile 10x` every 15 minutes until it reports
   none missing, then `pnpm load run --profile 10x --gate`. `billing` runs once per seeded database
   (the next run finds every tenant `done`); re-seed to repeat it, or leave it out with `--scenarios`.
5. **Record the result**: paste `summary.md` into §6 below (date, commit, profile, where the load came
   from) in a PR, tick T-095's acceptance criterion if every line passed, and open a task for each
   failure with the metric, the numbers and the suspected query or route.
6. **Clean up**: delete the `load/…` git branch (the Neon integration deletes its database branch) and
   the branch-scoped Vercel variables; delete `tools/load/.cache/sessions.json` (it holds sign-ins to
   that preview).

### CI job (to add once H-01 is done)

Not added to `.github/workflows` yet: there is no preview with a seeded database to point it at, and
this task owns only `tools/load/**` and this file. When H-01 is done, add this as
`.github/workflows/load.yml`. It runs **only by hand** (`workflow_dispatch`, never on pull requests), and
its secrets live in a GitHub *environment* `load-test` that only `workflow_dispatch` runs on protected
branches can use.

```yaml
name: Load test
on:
  workflow_dispatch:
    inputs:
      base_url: { description: "Preview URL (never production)", required: true }
      profile: { description: "smoke | legacy | 10x", required: true, default: legacy }
      scenarios: { description: "Comma-separated or all", required: true, default: all }
permissions:
  contents: read
jobs:
  load:
    runs-on: ubuntu-24.04
    environment: load-test
    timeout-minutes: 120
    env:
      LOAD_CRON_SECRET: ${{ secrets.LOAD_CRON_SECRET }}
      LOAD_VERCEL_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
      LOAD_FORBIDDEN_HOSTS: ${{ vars.PRODUCTION_HOSTS }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - name: Run
        env:
          BASE_URL: ${{ inputs.base_url }}
          PROFILE: ${{ inputs.profile }}
          SCENARIOS: ${{ inputs.scenarios }}
        run: pnpm load run --base-url "$BASE_URL" --profile "$PROFILE" --scenarios "$SCENARIOS" --out "$RUNNER_TEMP/load" --gate --no-cache
      - if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with: { name: load-results, path: "${{ runner.temp }}/load" }
```

`--no-cache` because a CI runner starts empty: a `legacy` run (76 users) fits one sign-in window; a
`10x` run from CI needs the `warm` step repeated 15 minutes apart (or a self-hosted runner that keeps
`tools/load/.cache`). GitHub's runners are in the US/EU, so their timings carry ~200 ms of network per
request (the baseline line says how much).

---

## 5. How it works (for whoever changes it)

- **No framework.** k6 or Artillery would be a new binary or a heavy dependency, and neither speaks
  Next.js Server Actions. Node 24's `fetch` (undici, keep-alive) is enough: one session (cookies or
  bearer token) per virtual user, every sample kept, exact nearest-rank percentiles.
- **Web sign-in** posts the login form the way a browser without JavaScript does (React progressive
  enhancement: the form's hidden `$ACTION_*` fields + `login` + `password`, multipart, same Origin): the
  real sign-in action runs, rate limits included, and answers 303 + the session cookie.
- **Counter payments** call the page's Server Actions as its JavaScript does (`POST /payments/new`,
  `Next-Action: <id>`, arguments as JSON). The ids are read from the page's own RSC payload (the `$h`
  references of `CounterPayment`'s props), so nothing is tied to one build. Both depend on Next.js 16
  internals: if an upgrade changes them, the tool reports a `NextProtocolError` (counter
  `counter.protocol_error`) instead of measuring something else.
- **Phones** use the mobile contract (`@cb/contracts` types; the tests check every request body against
  the contract's Zod schemas): a stable install id per (target, login), the device code from sign-in for
  provisional references, UUIDv7 payment ids.
- **Tests** (`tools/load/src/*.test.ts`) run every scenario against an in-process fake of the app and
  check: contract-valid requests, one sign-in per user, the cache (second run: zero sign-ins), the
  sign-in refusal before any load, `warm` in windows, an unhealthy target (exit 3), a failing page
  (exit 1 with `--gate`, `check` agrees), the budget table, the Next.js parsing, ids and options.

---

## 6. Results

### Capacity runs (Vercel preview + Neon)

None yet: H-01 (Vercel, Neon, Upstash accounts) is not done. T-095's acceptance criterion
"p95 < 2 s for listed operations; report committed" stays open until a `legacy` and a `10x` run are
recorded here.

### Local tooling smoke (not a capacity measurement)

> **These are tooling smoke results on a shared, loaded 4-CPU container, not a capacity
> measurement.** One `next start` process, the local Postgres 17 and the load generator shared the same
> 4 CPUs with other agents' builds (load average 9–11 during the runs). They prove that every
> scenario, the rate-limit plan, the result files and the gate work end to end. They say nothing about
> Vercel + Neon, where each request gets its own function instance and the database is elsewhere.

2026-10-14, commit `736f8d3` (T-095 branch on `feature/mvp` `fd84c43`), `next start` on a fresh scratch
database seeded with `pnpm db:seed --migrate --scale legacy --as-of 2026-09-30` (8 operators, 7,616
customers, 147,943 bills, 108,077 payments).

**1. `pnpm load run --base-url http://localhost:3295 --profile smoke --gate` (every scenario): PASS, exit 0.**
8 sign-ins. The billing run billed October for all 8 tenants in 137 s in 2 worker invocations (6,519
bills created, 228 customers with nothing to bill, 0 failed; counted in the database afterwards). 40
phone payments and 6 counter payments posted, every replayed item answered `duplicate`, 4 CSV files
(18,009 rows).

| Rule | Worst metric | p95 / value | Limit |
|---|---|---:|---:|
| B-WEB-LIST | `web.page.customers` (of 20 pages) | 1,045 ms | 2,000 ms |
| B-WEB-SEARCH | `web.search.name` | 336 ms | 2,000 ms |
| B-COUNTER-FIND / -SAVE | find / save | 140 / 345 ms | 2,000 ms |
| B-SYNC-PAGE / -FULL / -BYTES | page / full roster / bytes | 870 ms / 1,192 ms / 69.4 KiB | 2 s / 10 s / 1 MiB |
| B-PAY-BATCH | 10-item batches | 840 ms | 10,000 ms |
| B-EXPORT | `export.bills` (12 months) | 3,795 ms | 60 s |
| B-BILLING-RUN / -INVOCATION | wall / longest invocation | 137 s / 136.6 s | 30 min / 300 s |

**2. `pnpm load run --base-url http://localhost:3295 --profile legacy --scenarios sync,counter,reports,exports,payments --gate`
(billing already done): FAIL, exit 1.** 68 new sign-ins (8 reused from the cache), 0 errors on any
request (43 metrics), 6,000 phone payments + 80 counter payments posted (6,126 payments in the database
including run 1), 0 rejected, 0 `retry_later`, every replay `duplicate`, 24 files (86,153 rows).
What failed, on one Node process for 60 phones + 24 office users on 4 shared CPUs:

| Metric | p50 | p95 | Limit |
|---|---:|---:|---:|
| `web.page.*` (15 of 20 pages over) | 1.5–1.9 s | 2.1–2.7 s | 2 s |
| `web.search.name` / `.phone` | | 2.2 / 2.3 s | 2 s |
| `mobile.sync.page` / `.delta` | 1.9 s | 2.4 / 2.1 s | 2 s |
| `mobile.payments.batch` (50 items, 60 phones at once) | 24.3 s | 25.8 s | 10 s |
| `mobile.receipts.actions` (100 actions) | | 11.6 s | 2 s |
| passed: counter save / find, customer detail, day totals, full roster (5.6 s), exports (9.1 s) | | | |

This shows the gate catching a target that is too slow; it is **not** evidence about production.
It does point at what to watch on the first real run: a 50-payment batch is posted item by item in
one request (T-061), so 60 phones pushing at once queue on the database; locally a batch took 25.8 s
at p95, close to T-061's 30 s per-batch budget (after which items come back `retry_later` and the
phone re-sends them: safe, but slow). Receipt actions are also recorded one by one.

Earlier runs on the same container at a lower load average (2–3) passed every rule in `smoke`, and in
`legacy` failed only `mobile.sync.page` (2.3 s), `mobile.payments.batch` (20.1 s) and
`mobile.receipts.actions` (9.8 s): the same pattern, scaled by how busy the machine was.
