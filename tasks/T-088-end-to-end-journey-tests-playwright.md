---
id: T-088
title: End-to-end journey tests (Playwright)
phase: 4
area: qa
status: done
owner: agent-t088
claimed_at: 2026-10-14T11:47:52.264Z
branch: task/T-088-end-to-end-journey-tests-playwright
depends_on: [T-027, T-047, T-048, T-062]
review: self
claimable_by: agent
size: M
paths: [apps/web/e2e/**, apps/web/playwright.config.ts]
---

# T-088 — End-to-end journey tests (Playwright)

**Phase** 4 · **Area** qa · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-027, T-047, T-048, T-062

## Goal

Critical web journeys are protected against regressions.

## Scope

- Sign-up → setup → add customer + VC → preview + run bill → counter payment → handover accept → reports, in EN and HI.
- Runs against Vercel preview URLs in CI with a seeded Neon branch.

## Acceptance criteria

- [x] Suite is stable (no retries needed) across 5 consecutive runs. (Locally, full suite, 2 workers, `--retries=0`; see Verification for the one earlier load-related failure of an older spec.)

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/e2e/**`
- `apps/web/playwright.config.ts`

## References

PLAN §16, PRD §15 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| File | What |
|---|---|
| `apps/web/e2e/journey-month.spec.ts` | **An operator's first month**, 9 serial steps on one business made by **signing up** (email link from the outbox). Everything goes through the app's pages and the lineman app's real API; every step checks that the numbers agree with the pages before it. |
| `apps/web/e2e/journey-hindi.spec.ts` | **The same loop in Hindi on a 360px phone**: sign in in Hindi → plan → customer with a connection → preview + make bills → ₹200 cash at the counter → Home, bill, history and due list all say ₹100 due; no page scrolls sideways. Every Hindi word comes from `apps/web/messages/hi.json` through the app's own translator (no Hindi copied into the test). |
| `apps/web/e2e/_support/journey.ts` | Small helpers for journeys: `words(locale)` (next-intl `createTranslator` over the generated messages, ICU plurals work), `runJobs(db)` (the job worker, as bills.spec.ts runs it), `journeyIp(seedId)`, `apiHeaders(ip)`, `phoneDevice()`, `expectNoSideways(page)`. |

**The month journey** (numbers: Asha 2 VCs ₹250 + ₹350, Bina ₹250, Chandu ₹200 + a ₹700 old due)

1. Sign up → Settings: 2 areas, 2 plans, a lineman (checklist 0 → 2 of 4).
2. Customers: Asha through the 3-step form + the Connections tab (2 VCs); Bina and Chandu from a **CSV through the import wizard** (T-084; day-first start dates, plan by name and own rent). Bina's code `102` is also used by another business (allowed); a second `102` in this business is refused. Chandu's ₹700 old due is written directly as the migration brings it (an `opening_balance` bill + ledger line): the import file has no old-due column. Checklist 3 of 4.
3. Bills: preview (3 customers, ₹1,050, no problems) → Make bills → job worker → made → register → Asha's **one** bill has **both** VCs (₹600).
4. Counter: Chandu ₹800 cash → old bill Paid, this month's Part paid, ₹100 due; Bina ₹300 UPI → "₹50 credit" on the receipt screen and the customer page.
5. Phone (mobile API): login; roster balances = the web's; a batch (Asha ₹400 cash + ₹100 UPI + one for the **other business's** customer → `posted, posted, rejected CUSTOMER_NOT_FOUND`); replayed 3× at once → `duplicate`, same receipts; allocations; detail of the other business's customer → 404; day totals cash/UPI apart; ₹350 handed over for ₹400 (`short`); receipt actions `printed`/`whatsapp_opened` recorded, `sent` rejected.
6. Office: checklist gone (the phone signed in); Home alert → Linemen (₹400 / ₹100, "₹50 short") → Accept; the lineman's payment page shows the receipt no. **and** the phone's temporary no., "By a lineman", and never "sent"/"delivered".
7. **Numbers agree**: Home (cash ₹1,200, UPI ₹400, 4 payments, ₹1,050 billed, ₹1,600 taken, ₹200 due / 2 customers) = payment register = bill register (₹1,050 / ₹850 / ₹200) = due list (₹200, ₹50 credit, net ₹150, ageing, by area) = bills report = payments report = each customer's History closing and bill outstanding = the phone's roster. Home again in Hindi. The other business's customer, history, bill, printable bill, payment and receipt PDF → 404.
8. Bina's plan → Gold after the bill: "₹100 extra will be added to the next bill", Bill changes ₹100 pending; Chandu's VC removed and given to Bina from tomorrow; preview "No customer will get a new bill … 3 already have a bill" → Make bills again → still 3 bills (₹1,050, checked in the DB too); Bina's issued bill still ₹250 with one VC; Chandu's still lists his old VC; dues unchanged.
9. Owner undoes Bina's ₹300 (Wrong customer): Cancelled, ₹250 due; Home (UPI ₹100, 3 payments, ₹1,300 taken, ₹450 due / 3), register ("1 cancelled, not counted"), due list (₹450, ₹0 credit), payments report, bill register (₹600 paid / ₹450 due), History ("Cancelled later", closing ₹250) and the phone all move together; "Who changed what" shows "Meera Owner (Owner) cancelled payment R-… of ₹300 (customer 102)" and the handover acceptance.

**PRD §15 → journey evidence**

| # | Covered by |
|---|---|
| 1 cross-tenant | month 5 (API: other tenant's customer rejected / 404), 7 (web: customer, history, bill, print, payment, receipt PDF → 404) |
| 2 code per tenant | month 2 |
| 3 multi-VC → one invoice | month 2, 3 |
| 4 bill twice, no duplicate | month 8 (preview + real re-run + DB count) |
| 5 plan change after issue | month 8 |
| 6 VC reuse keeps history | month 8 (the issued bill keeps the VC on the old customer) |
| 7 oldest-first + visible credit | month 4 (+ phone allocations in 5) |
| 8 offline payment not duplicated | month 5, server side only (replayed batch ×3 in parallel). Restart survival is Android (T-066/T-072). |
| 9 permanent receipt ↔ provisional | month 5 (API), 6 (web payment page) |
| 10 print/share failure | not web: Android unit tests (T-068/T-069) |
| 11 no false delivery claim | month 5 (`sent` rejected), 6 (no "sent"/"delivered" on the page) |
| 12 cash/UPI split + handover discrepancy | month 5, 6 |
| 13, 14 migration / backup | not e2e (T-091/T-092, restore drill) |

**Decisions**

- **One sign-in per journey.** The month journey reuses the sign-up's session (`storageState`) in every step, and both journeys send a per-seed TEST-NET `x-real-ip` (web and API). The whole suite shares one server's per-IP sign-in limit (100 per 15 min) and is already close to it (~90 sign-ins); the journeys add none to that budget. Against a deployed URL Vercel overwrites the header, which is fine (they then add 1 web sign-in, 1 sign-up and 1 phone login).
- Steps are separate serial tests (not one long test) so a failure names the step; later steps are skipped when one fails.
- Seeded data is limited to what has no page yet: the other business (cross-tenant ids), the Hindi business's account, and Chandu's old due (no page or import column brings an old due; migration does). Everything else is made through the UI or the mobile API.
- No change to `playwright.config.ts` was needed.

**Things the journeys found (not bugs, reported for the owner)**

- After "Make bills now" is run **again**, the run summary still says **New bills: 3** (the run row is per month and its counts are cumulative over its items; nothing new was billed — the preview said "No customer will get a new bill" and the DB has 3 invoices). The label "New bills" may read as "made just now". Journey asserts the current behaviour.
- After an undo, the **payment register** says "4 payments · 1 cancelled, not counted" while **Home** says "3 payments" today: two different meanings of the count on two pages. Both are documented in their own pages; a product decision whether to align them.

**Gaps**

- "Runs against Vercel preview URLs in CI with a seeded Neon branch" is not done: it needs H-01 (Vercel/Neon integration, secrets). The specs already support `E2E_BASE_URL` (the month journey skips there, since it needs the local email outbox; the Hindi journey runs).
- The collection / handover / connection reports (T-081) are not merged; add them to step 7 of the month journey when they land.
- PRD §15 #8 (survives an app restart), #10 (print/share failure) are Android; #13/#14 are migration and restore drills. Not web e2e.

**Verification** (Node 24.21.0, pnpm 12.11.2, Postgres 17, scratch DB migrated once, `next start` build)

- Runtime: the month journey ~1.6–2.5 min (9 serial steps, one worker), the Hindi journey ~20–45 s, in parallel with the rest. Full suite with 2 workers on this (shared, heavily loaded) 4-core container: 95 tests in 6.0 min before; 107 tests in 5.0–8.9 min after.
- **Full web e2e suite, 2 workers, `--retries=0`, 5 consecutive runs against the same scratch DB, after the final rebase: 5/5 green** (107 passed each; 6.5, 8.9, 5.6, 6.1, 5.0 min).
- Before the rebase: 4 more full runs green (105 tests); one run had **1 failure in `audit.spec.ts` ("Staff can't open it")**: its first `/login` did not render within 30 s while the container's load average was 30–40 (other agents' Gradle builds); not a journey test, not reproduced in the next 5 runs. Two loop iterations never started because the shared pnpm shim was broken for ~2 min (someone ran `corepack enable`); not counted.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (`--filter @cb/web`), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-14T11:47:52.264Z claimed by agent-t088
- 2026-10-14T13:53:47.405Z completed on task/T-088-end-to-end-journey-tests-playwright
