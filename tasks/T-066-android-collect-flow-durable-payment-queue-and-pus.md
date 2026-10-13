---
id: T-066
title: Android: collect flow, durable payment queue and push sync
phase: 3
area: android
status: done
owner: agent-t066
claimed_at: 2026-10-13T14:25:34.419Z
branch: task/T-066-android-collect-flow-durable-payment-que
depends_on: [T-065]
review: required
claimable_by: agent
size: L
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/collect/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/waiting/**, apps/android/app/src/main/java/com/cablebilling/lineman/data/sync/PaymentSync*.kt, apps/android/app/src/main/java/com/cablebilling/lineman/data/payments/**, packages/i18n/messages/*/mobile_collect.json]
---

# T-066 — Android: collect flow, durable payment queue and push sync

**Phase** 3 · **Area** android · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-065

## Goal

A payment is never lost and never duplicated.

## Scope

- Amount (pre-filled due, chips), Method (Cash/UPI tiles, optional UPI ref with Skip), Confirm (spoken summary), Done (receipt no. permanent or provisional `P-<device>-<seq>`, action tiles wired as placeholders for T-069).
- UUIDv7 + provisional ref created before the Room insert; Room transaction completes before 'Saved' is shown.
- PaymentSync worker: unique work, network constraint, batches of 50, maps outcomes to states (SAVED_ON_PHONE, SENT_TO_OFFICE, NEEDS_OFFICE_HELP), links permanent receipt number, never deletes.
- Waiting screen (unsynced/problem list, 'Try now', call office).
- Different user signs in with queued payments from another user → hold queue + flag (PLAN §9.2).

## Acceptance criteria

- [x] Kill app right after Save → payment present after restart and syncs once. (Robolectric simulation; real-device check listed in the notes.)
- [x] Retrying a batch after a timeout produces no duplicates (server returns duplicate outcome).

## Tests required

- ViewModel + worker tests with MockWebServer fault injection; Compose UI test of full flow.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/collect/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/waiting/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/sync/PaymentSync*.kt`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/payments/**`
- `packages/i18n/messages/*/mobile_collect.json`

## References

PLAN §10.4, PLAN §11.3 (Amount, Method, Confirm, Done, Waiting), FR-015, FR-016, BR-11, RULE-16, RULE-17 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**Acceptance criteria:** both are met **in the JVM tests (Robolectric)**. Neither was checked on a real
phone: this container has no emulator. "Kill the app" is simulated by closing the Room database and every
in-memory object, then starting a new "process" (new database, session store, network stack, sync and
scheduler) on the same files. The real-device checks are listed at the end.

**What exists** (`apps/android/app/src/main/java/com/cablebilling/lineman/…`; overview in `apps/android/README.md`)

- `data/payments/`: `UuidV7` (RFC 9562 v7, lower case), `PaymentDraft` + `SaveResult`
  (`Saved(paymentId, provisionalRef, isNew)` / `NotSignedIn` / `Invalid` / `Failed`), `PaymentRules`
  (whole rupees, max, UPI ref 1–64 and UPI only, `P-{code}-{seq:04}`, IST `businessDate`),
  `PaymentRepository` (`save`, `get`, `observe(id)`, `observeWaiting()`), `PaymentPushTrigger`,
  `PaymentEntity.isHeldFor(userId)`, `PaymentReceipts` (row + session → T-068 `ReceiptModel`; allocations
  JSON), `PaymentsModule` (Hilt: trigger = `PaymentSyncScheduler`).
- `data/sync/PaymentSync` (engine, `run(): PaymentSyncResult` = `Done(sent, needsHelp)` /
  `RetryLater(sent, failure?)` / `Stopped(sent, failure)` / `NotSignedIn`; `status: StateFlow<PushStatus>`),
  `PaymentSyncWorker` (`@HiltWorker`), `PaymentSyncScheduler` (`start()`, `requestPush()`, `tryNow()`,
  `enqueue()`, `pushIfOwnPayments(userId)`; unique work `payment-sync`, tag `payment-sync`).
- `feature/collect/`: `CollectScreen` / `CollectContent` + `CollectViewModel` (assisted `customerId`,
  `SavedStateHandle`), `CollectData` / `AppCollectData`, `CollectUiState` (`CollectStep` Amount → Method →
  UpiReference → Confirm, `CollectProblem`), `CollectDoneScreen` / `CollectDoneContent` +
  `CollectDoneViewModel` (assisted `paymentId`), `CollectDoneRoute(paymentId)` +
  `NavController.navigateToCollectDone`, `ReceiptShareActions`, `CollectTags`, shared bits
  (`BackRow`, `InfoLine`, `CallOfficeButton`, `PaymentState.status`, `PaymentStatus.word`).
- `feature/waiting/`: `WaitingScreen` / `WaitingContent` + `WaitingViewModel`, `WaitingData` /
  `AppWaitingData`, `WaitingUiState` / `WaitingItem` / `WaitingKind` (OnPhone, Held, Problem), `WaitingTags`.
- Strings: namespace `mobile_collect` (31 keys, Hindi in `_review` except WhatsApp/SMS). Glossary: new
  "Collect words" table.

**The flow** (PLAN §11.3)

- Customer → Collect → **Amount**: pre-filled with the projected due (rounded **up** to whole rupees),
  "अभी बाकी: ₹X", quick amounts full due / ₹100 / ₹200 / ₹500, `NumberPad` with 00 (the first key after a
  pre-fill or a chip types a new amount; max 7 digits = ₹99,99,999), Next. → **Method**: two giant tiles
  नकद / UPI. UPI → **UPI ref** (optional text field, Skip / Next). → **Confirm**: `ConfirmCard`, read-out
  "Ramesh Kumar से पाँच सौ रुपये नकद" (`VoiceLines.collected`) + speak button, green Save. → **Done**
  (`CollectDoneRoute`, replaces the flow on the back stack): tick, "पैसे सेव हो गए", amount, name, amber
  "अस्थायी नं. P-K7Q-0001" + "फ़ोन में सेव" + "goes by itself when there is internet" (spoken: "पैसे फ़ोन में
  सेव हो गए"), turning by itself into green "रसीद नं. R-2610-00045" + "ऑफिस पहुँच गया" when the push answers
  (posted_needs_review: "money is safe, the office will check"; rejected: red + Call office). Tiles:
  **Print** (T-068 `ReceiptPrinter`, result spoken; failure shows the problem + "The payment is saved. Only
  the printing failed." + "Set up printer" when `needsSetup`), WhatsApp and SMS (shown disabled until T-069
  passes `ReceiptShareActions`), Done (back to the search home). Back from Done → customer screen.
- Back walks the steps (system back too); on Amount it leaves the flow. Everything typed, the step and
  the payment id survive process death (`SavedStateHandle`).

**Queue states** (no new state; `payments.state` is unchanged from T-064, so no migration)

| State | When | Shown as |
|---|---|---|
| `SAVED_ON_PHONE` | saved; and after offline / timeout / 429 / 5xx / unreadable answer / `retry_later` / missing result / APP_TOO_OLD / signed out | amber clock "फ़ोन में सेव" |
| `SAVED_ON_PHONE`, `collector_id` ≠ signed-in user | another lineman's payment on a shared phone: **held**, never sent | amber chip + red "दूसरा लाइनमैन", held block with Call office on Waiting |
| `SENT_TO_OFFICE` (+ `receipt_number`, `posted_at`, `posted_business_date`, `balance_after_paise`, `credit_after_paise`, `allocations_json`, `synced_at`; `review_reason` for posted_needs_review) | `posted`, `duplicate`, `posted_needs_review` (the result must echo the id and provisional ref) | green "ऑफिस पहुँच गया" |
| `NEEDS_OFFICE_HELP` (+ `last_error_code`) | `rejected` — never retried automatically | red "दिक्कत" + Call office |

Rows only move forward from `SAVED_ON_PHONE`, and nothing is ever deleted. `attempt_count` /
`last_attempt_at` are set before each send, and `last_error_code` holds the failure (`offline`,
`server:INTERNAL`, `malformed`, `no_result`, item error code …).

**APIs for later tasks**

- **T-069 (receipt PDF / sharing):** `CollectDoneScreen(paymentId, onPrinterSetup, onFinish, shareActions =
  ReceiptShareActions(onWhatsApp = …, onSms = …))` (or pass them through the `collectDone` slot in
  `CableApp`). Receipt content: `PaymentReceipts.model(payment, session, json)` (permanent number once
  posted; provisional with no bills/balance before). Payment: `PaymentRepository.observe(id)` / `get(id)`.
  Record `printed` / `print_failed` in the outbox from `CollectDoneViewModel.print()` (not done here: the
  outbox belongs to T-069).
- **T-070 (Today / handover):** rows have `business_date` = IST date of `recorded_at`
  (`PaymentRules.businessDate`); `PaymentDao.observeDay(collectorId, date)`; chip mapping
  `PaymentState.status` + `PaymentStatus.word`; unsynced cash for the handover = the lineman's
  `SAVED_ON_PHONE` cash rows. Held rows: `PaymentEntity.isHeldFor(userId)`.
- **T-061 (server batch):** what the phone sends: ids lower-case UUIDv7; `recorded_at` always
  `yyyy-MM-ddTHH:mm:ss.SSSZ`; `provisional_ref` `P-{device_code}-{seq ≥ 4 digits}`, sequence per device
  code on this install; `collector_id` / `device_id` from the session when it was saved; `upi_reference`
  only for UPI; ≤ 50 items, oldest first; a retry resends **identical** items. The phone matches results by
  `id` and needs a posted result to echo `id` and `provisional_ref` (otherwise it keeps the payment and
  resends). `retry_later` and a missing result keep the payment.
- **T-071 (settings / sign out):** warn before sign-out while `PaymentDao.oldestSavedOnPhoneFor(userId, 1)`
  is not empty. **T-072 (durability suite):** reuse `FakePaymentServer` (idempotent fake office with
  fault injection) and the process-death pattern in `PaymentSyncWorkerTest`.
- After a push that posted anything: `RosterSyncScheduler.requestNow()` (the worker and "Try now").

**Decisions (please check in review)**

1. **Unique work `payment-sync` with `APPEND_OR_REPLACE`, and at most one waiting run.** Every request made
   after a commit has to produce a run that *starts* after that commit. KEEP drops a request that arrives
   while a run is finishing (it has already read an empty queue), so the new payment would wait for some
   later trigger. REPLACE cancels a run in the middle of a batch: safe thanks to idempotent ids, but wasted,
   and it can starve the push while payments are saved quickly. APPEND keeps runs strictly sequential.
   `enqueue()` adds nothing while a run is already ENQUEUED (incl. backoff) or BLOCKED, because that run
   starts later and reads the queue fresh, so the chain stays ≤ 2. `_OR_REPLACE` starts a fresh chain after
   a failed one.
2. **Retries have no attempt limit** (exponential backoff from 30 s; WorkManager caps the delay at 5 h).
   Non-temporary failures (signed out, APP_TOO_OLD, whole-batch 4xx) end the run with `failure()`, and the
   next trigger restarts it: sign-in, app open, a save, or Try now. An unreadable 2xx (captive portal) is
   retried, never trusted.
3. **Triggers:** after every save (after the commit), on sign-in with own payments, on app foreground,
   and on Try now. `start()` (from `CableApplication.onCreate`) also loads the stored session itself, so a
   payment saved just before the app was killed is pushed at the next start even if its work request was
   never enqueued.
4. **Payment id made when Confirm first opens** and kept in `SavedStateHandle` for the whole flow.
   `PaymentRepository.save` is idempotent on that id: a double tap, or Save again after process death,
   gives one row. If the lineman changes the amount after a restore of an already-saved flow, Done shows
   the payment that really was saved.
5. **Provisional sequence** = count of rows with the same `P-{code}-` prefix + 1, read inside the insert's
   transaction. Rows are never deleted, so it never repeats on this install. The unique index catches any
   race.
6. **Shared phone (PLAN §9.2):** the push sends only payments whose `collector_id` is the signed-in user's.
   It stops before a batch if the signed-in user changed. Held payments stay `SAVED_ON_PHONE` (still
   counted in the projected due and in "N payments on phone", because the money was really taken). They are
   flagged on the Waiting tab with Call office and sync normally when their lineman signs in again.
7. Done's "Done" tile goes to the search home (next customer). Back goes to the customer.
8. Due with paise is pre-filled **rounded up** to whole rupees (D-17), so "full due" clears it.
9. WhatsApp / SMS tiles are visible but disabled until T-069 wires them.

**Open questions**

- **A deactivated lineman's queue (T-046 open question).** Today ACCOUNT_DISABLED ends the session. The
  payments stay on the phone forever (never lost) and show as another lineman's held payments to whoever
  signs in next, with "Call office". *Proposal:* an office-approved release. The Owner presses "Send this
  phone's held payments" on the web, and `/app/config` carries `release_held_for: [user_id]`. The phone
  then sends those payments under the current lineman's token with the original `collector_id`. The server
  posts them as `posted_needs_review` (`collector_inactive` / `collector_mismatch`), and per T-046 decision 4
  the claimed collector is not part of idempotency. Alternative: let a disabled lineman's still-registered
  device call `/payments:batch` only, for a grace period. I recommend the first (the office stays in
  control, and no credentials are shared).
- **Residual window:** the bearer token is read when a request starts. If another lineman signs in while
  a batch is in flight and the request needs a 401-refresh retry, `TokenRefresher` would reuse the new
  session's tokens. Signing in needs a sign-out plus typing first, so this is very unlikely, and the server
  flags it (`collector_mismatch`). T-063/T-028 could bind the refresh retry to the same user.
- Amount cap on the pad (₹99,99,999; the contract allows 13 digits) and whether to warn when the amount
  is far above the due.
- Waiting tab badge with the unsynced count (PLAN §11.2) is not added. It needs a count source in the
  bottom bar (`CableApp`). Follow-up.

**Deviations / files outside the owned paths**

- `data/db/PaymentDao.kt` (T-064, done): two read queries, `oldestSavedOnPhoneFor(collectorId, limit)` and
  `countWithRefPrefix(prefix)`. No schema change, no migration, identity hash unchanged.
- `ui/CableApp.kt`: `CollectRoute` → `CollectScreen`, new `CollectDoneRoute`, Waiting → `WaitingScreen`;
  new slots `collectScreen`, `collectDone`, `waitingScreen` (Hilt defaults);
  `CollectDoneRoute` in the Search tab's sub-screens. `ui/navigation/TopLevelDestination.kt`: KDoc only.
- `CableApplication.kt`: one injected field + `paymentSync.start()`.
- Deleted the placeholder `feature/queue/WaitingScreen.kt` (T-008); the Waiting tab is now `feature/waiting`.
- `CableAppNavigationTest`: passes a Waiting stand-in (the real one needs Hilt).
- `apps/android/README.md`, `packages/i18n/glossary.md`; regenerated `strings_generated.xml` (en/hi) and
  `apps/web/messages/{en,hi}.json`.
- Tests live beside the owned paths in `app/src/test/.../data/payments`, `data/sync`, `feature/collect`,
  `feature/waiting`.

**Verification** (JDK 21, Android SDK, Node v24.21.0, pnpm 12.11.2, Postgres 17; no emulator)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`: BUILD
  SUCCESSFUL. App JVM tests 250 (41 new), 0 failures. Designsystem 31. Lint: 0 errors, 2 existing warnings.
  The new and touched UI test classes (47 tests) were rerun twice more and stayed green. A mutation check
  failed the shared-phone test as expected (pushing without the collector filter), then was reverted.
  New tests:
  - `PaymentRepositoryTest` (6): UUIDv7 layout, order and uniqueness. Save commits the row (id, P-K7Q-0001,
    IST date across midnight, collector/device) **before** the push is requested (the trigger sees the
    row). Refs count up per device code; a new device code starts a new sequence. A double save, or a save
    after a "restart", keeps one row. Invalid drafts or signed out → nothing written. Cash never stores a
    UPI ref.
  - `PaymentSyncTest` (9, MockWebServer): the request body equals `postPaymentBatch.request.json`, and the
    five outcomes of `postPaymentBatch.response.json` map to their states (receipt no., posted_at,
    allocations, balance after, review reason, rejected code, retry_later stays; the retry sends only that
    one). 120 payments → batches 50/50/20, oldest first, each posted once. **Answer lost after the office
    committed** → stays on the phone, the retry resends identical items, the office answers duplicate:
    3 posted, 6 received, no double count. 500 / 429 / an HTML 200 → retry, attempts counted. Partial
    outcomes in one batch. A posted result without its payment, or a missing result → kept. APP_TOO_OLD
    and a refused refresh (DEVICE_REVOKED) → stopped, kept; signed out → nothing sent. **Another lineman
    signed in** → only his payment is sent, the first lineman's stay untouched until he signs in again.
    No internet → kept.
  - `PaymentSyncWorkerTest` (8, WorkManager test driver): posted → success + roster pull enqueued; nothing
    to send → success, no pull; offline / 5xx → retry even at attempt 100; APP_TOO_OLD → failure; signed
    out → success with the payment kept. Unique work: CONNECTED, exponential 30 s, one waiting run however
    often it is requested, runs when the network comes back, a new run after a finished one. Sign-in pushes
    only the signed-in lineman's own payments. **Kill right after Save**: file-backed Room + session
    DataStore, the "process" is closed and a new one started on the same files; `start()` finds the payment
    and the office receives it exactly once; another app start sends nothing. **Killed after the office
    committed but before the phone stored the answer** → after restart: duplicate, SENT_TO_OFFICE, posted
    once.
  - `CollectViewModelTest` (9): due pre-fill (rounded up; empty when nothing is due), the first key replaces
    the pre-fill, chips, the 7-digit cap, steps and back. Cash → Confirm read-out in Hindi and English.
    Save while saving is ignored, and "saved" appears only after the save returns. UPI ref (64-char cap,
    Skip, typed). After process death (`SavedStateHandle`) the same id is used. Failed / signed-out saves
    show a problem and can be retried with the same id. Not-found customer.
  - `CollectFlowTest` (3, Compose UI on Robolectric, Hindi, 360 × 800 dp, real `CableApp` NavHost, real
    ViewModels, in-memory Room, MockWebServer): search 1045 → Ramesh → Collect → ₹900 pre-filled → ₹500 chip
    → नकद → Confirm (card + read-out) → Save → Done only after the row exists: "अस्थायी नं. P-K7Q-0001", "फ़ोन
    में सेव", "पैसे फ़ोन में सेव हो गए" spoken, nothing says "sent", the collect flow is gone from the back
    stack, WhatsApp/SMS disabled → push → the screen shows "रसीद नं. R-2610-00045" and "ऑफिस पहुँच गया" → Print
    (permanent number, bills, lineman, operator) → Done back to the search home. UPI path with a typed
    reference and a failed print ("पेमेंट सेव है…", "प्रिंटर लगाएँ", payment untouched). Back through the steps
    to the customer, nothing saved. Every tappable ≥ 56 dp on each screen.
  - `WaitingViewModelTest` (4) and `WaitingScreenTest` (2, Compose, Hindi): order (problems, own, held),
    held block "दूसरे लाइनमैन के 2 पेमेंट" + Call office, refused row with Call office dialing
    `tel:9800000001`. Try now offline → "इंटरनेट नहीं है…"; online → own payments leave the list, the held ones
    are never sent, the refused one stays. Empty state, touch targets.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (incl. DB tests on
  Postgres 17), `pnpm build`, `pnpm generate` (no diff beyond this task's strings), `tokens:build --check`,
  `icons:build --check`, `i18n:check`, `i18n:build --check`, `openapi:build --check`,
  `node scripts/tasks.mjs check --local`: all pass.
- One unrelated flake seen once in a full run under heavy load: `PrinterSettingsTest` (T-068), "multiple
  DataStores active for the same file". It passed on rerun.

**Still needs a real phone / emulator**

- Kill right after Save on a real phone (swipe away, `adb shell am kill`, and **force stop**, which
  cancels WorkManager jobs until the next launch: `start()` covers it) on API 26 and 35+. Then reopen: the
  payment must be there and sync once.
- **Power cut / battery pull** right after Save. A process kill keeps committed WAL data, but a power cut
  depends on the WAL sync mode (T-064 follow-up: `PRAGMA synchronous=FULL` on the write connection if
  OEMs set NORMAL).
- Reboot with queued payments; airplane mode on → off; Doze and OEM battery savers (Xiaomi / Oppo / Vivo
  autostart limits) delaying the network-constrained work.
- Hindi layout of the Amount screen on small screens (360 × 640 dp: pad + chips + amount; the middle part
  scrolls). Tested at 360 × 800 dp only.
- Real Google TTS for the Confirm and Done read-outs, printing from Done on a real printer (H-05), and the
  UPI ref keyboard (Ascii; a number keyboard may suit better — field test).
- Hindi review (H-03): `mobile_collect` `_review` and the new glossary rows.

## Board log

- 2026-10-13T14:25:34.420Z claimed by agent-t066
- 2026-10-13T15:14:29.689Z completed on task/T-066-android-collect-flow-durable-payment-que
