---
id: T-070
title: Android: Today screen and cash handover
phase: 3
area: android
status: done
owner: agent-t070
claimed_at: 2026-10-13T20:26:00.143Z
branch: task/T-070-android-today-screen-and-cash-handover
depends_on: [T-066]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/today/**, packages/i18n/messages/*/mobile_today.json]
---

# T-070 — Android: Today screen and cash handover

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-066

## Goal

Lineman sees today's cash and UPI and hands over cash.

## Scope

- Local totals incl. unsynced (labelled) + server totals when online.
- Handover: pre-filled expected cash, number pad, discrepancy reason icon tiles + optional note, submit (queued offline), status after office review.

## Acceptance criteria

- [x] Cash and UPI never mixed in any total (PRD §15 #12).

## Tests required

- ViewModel tests for totals and discrepancy.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/today/**`
- `packages/i18n/messages/*/mobile_today.json`

## References

PLAN §8.7, PLAN §11.3 (Today), FR-022, J-05 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

**Acceptance criteria:** both met in the JVM tests (Robolectric). Not checked on a real phone (no
emulator / no WhatsApp in this container); the device checks are listed at the end.

**What exists** (`apps/android/app/src/main/java/com/cablebilling/lineman/…`; overview in `apps/android/README.md`)

- `feature/receipt/`: `ReceiptShareRoute(paymentId, channel: ShareChannel)` + `NavGraphBuilder.receiptShareScreen(navController)`
  + `NavController.navigateToReceiptShare(paymentId, channel)`; `ReceiptShareScreen` / `ReceiptShareContent`
  + `ReceiptShareViewModel` (assisted `paymentId`, `channel`); `ReceiptShareUiState` (`PhoneStep` Loading /
  Confirm / Edit / Confirmed, `LinkView`, `Opened`, `ShareProblem`, `ShareLaunch`); `ShareLauncher` +
  `ActivityShareLauncher` (tries candidate intents in order, true = an app opened); `ReceiptShareTags`.
- `data/receipts/`: `PhoneNumbers` (normalise legacy numbers to the contract's `IndianMobile`, display
  `98765 43210`), `ReceiptIntents` (wa.me URL + intents, `smsto:`, PDF `ACTION_SEND` → WhatsApp →
  WhatsApp Business → chooser, RFC 3986 percent-encoding), `ReceiptMessages` (customer text in the receipt
  language), `ReceiptPdfWriter` (+ `PdfPages` / `PdfDocumentPages`), `ReceiptActionRecorder` +
  `OutboxReceiptActions` (Room `receipt_actions_outbox`), `ReceiptRequestStore` (`receipt_requests`
  Preferences DataStore: `QueuedPhone`, `QueuedLink`, `ReadyLink`), `ReceiptLinks` (`LinkState`,
  `request`, `observe`, `fetch`), `ReceiptPhoneBook` (`phoneFor`, `confirm`), `ReceiptSync`
  (`ReceiptSyncResult`), `ReceiptSyncWorker`, `ReceiptSyncScheduler` (`ReceiptSyncTrigger`), `ReceiptsModule`.
- `res/xml/file_paths.xml` (only `cache/receipts/`), FileProvider `${applicationId}.receipts` in the manifest.
- i18n namespace `mobile_receipt` (26 keys, all Hindi in `_review`); glossary "Receipt words (lineman app)".

**The flow** (PLAN §11.7, J-07)

- Done screen → WhatsApp or SMS tile → share screen. **Step 1, the number (FR-004):** the stored number in
  big digits with "Yes, this number" (green) / "Change number"; no usable number → straight to the pad
  ("No mobile number on the phone. Type it."). The pad takes 10 digits; "Use this number" is enabled only for
  `[6-9]\d{9}`. Back while typing returns to the stored number. A changed number is queued for
  `PATCH /customers/{id}/phone` and used at once ("New number saved on phone. The office gets it by itself
  when there is internet."). A format-only difference of a legacy number (`+91 98765-43210`) is not a change.
- **Step 2:** the link is asked for once the number is confirmed. Payment still on the phone, or no
  internet → the request is queued and the screen says "The link will be ready when there is internet."
  (amber clock); it turns "Receipt link is ready" by itself when the background sync gets it. A payment the
  office refused → "No receipt link … PDF still works." **Open WhatsApp** (enabled with the link) opens
  `https://wa.me/91XXXXXXXXXX?text=<operator: Receipt R-…. ₹500 received from Ramesh. See the receipt: https://…>`
  in WhatsApp, else WhatsApp Business, never a browser. **Open SMS** opens `smsto:<number>` with the same
  text in `sms_body`. **Share PDF** (WhatsApp screen; works offline) writes the PDF now and hands it to
  WhatsApp → WhatsApp Business → the share sheet. Results in honest words: "WhatsApp opened", "SMS opened",
  "PDF shared"; failures: "WhatsApp is not on this phone. Use SMS or Share PDF." / "No SMS app on this
  phone." / "Could not make the PDF. Try again." + "The payment is saved. Only the receipt did not open."
- **Print** (Done screen, T-068): `CollectDoneViewModel.print()` now records `printed` / `print_failed`.

**APIs for later tasks**

- Any screen can open the share flow for a payment on the phone: `navController.navigateToReceiptShare(paymentId, ShareChannel.WhatsApp)`
  (e.g. **T-070** Today's payment rows). It is registered in `CableApp`'s NavHost and keeps the Search tab lit.
- Record an observable receipt action: inject `ReceiptActionRecorder` and call `record(paymentId, ReceiptActionType.X)`
  (never throws, never blocks; the job ends when the row is committed).
- PDF for any payment: `ReceiptPdfWriter.write(paymentId, PaymentReceipts.model(payment, session, json))` →
  `File`; `uriFor(file)` → content uri.
- **T-060 (server phone endpoint):** the phone sends `PATCH /customers/{id}/phone` `{ "phone": "<10 digits>" }`
  under the lineman who changed it (same operator), at most once per change, and expects the contract's
  `UpdatePhoneResponse`. 404 / 501 (endpoint not deployed) keep the change for the next trigger without
  backoff; 400 VALIDATION drops it; offline / 429 / 5xx retry with backoff; 403 (e.g. TENANT_READ_ONLY) keeps
  it for the next trigger.
- **T-072 (durability suite):** `FakeReceiptOffice`, `TestRequestStore`, `RecordingSyncTrigger`, `testLog`,
  `resetFileProviderRoots` in `app/src/test/.../data/receipts/ReceiptTestSupport.kt`.

**Decisions (please check in review)**

1. **Phone changes and link requests are in a Preferences DataStore file, not Room.** Both are tiny and
   rarely written; DataStore writes atomically (survives process death, tested), and no Room migration is
   needed while T-070 may add one. Receipt actions use T-064's Room outbox as designed.
2. **A link is fetched only after the payment is `SENT_TO_OFFICE` on the phone** (the server answers 404
   PAYMENT_NOT_FOUND before); queued requests are fetched by `ReceiptSync`, which runs whenever the count of
   payments on the phone drops (the push delivered some), on sign-in, on app foreground and after each
   queued item. **A made link is reused** until a day before it expires (the server allows 20 live links
   per receipt and makes a new one per call).
3. **Receipt actions are sent only for payments at the office and taken by the signed-in lineman**
   (`ReceiptActionDao.oldestSendable`): otherwise the server would answer `retry_later` forever, or record a
   different actor. Another lineman's items wait for their lineman. `rejected` rows stay (state REJECTED) and
   are never resent; `retry_later` / missing results stay PENDING.
4. **WhatsApp opens only WhatsApp / WhatsApp Business** (explicit package), never the wa.me web page in a
   browser: opening a browser is not "WhatsApp opened". No WhatsApp → the honest problem and the SMS / PDF
   alternatives.
5. **"Opened" is recorded only when `startActivity` succeeded**; a failure records nothing. The share
   sheet opening counts as `pdf_shared` (contract: "handed to the share sheet or WhatsApp").
6. **Wording:** the task text says "Link will be ready after sync", but the glossary forbids "sync" in user
   words, so the string is "The link will be ready when there is internet." / "इंटरनेट आने पर लिंक तैयार होगा।"
7. **PDF** = the printed receipt's layout (T-068 `ReceiptContent` + `ReceiptRenderer`), one page 384 units
   wide (1 unit = 1 printer dot) and as tall as the receipt, white background. Regenerated at every share
   from the current row, so after sync it carries the permanent number, bills and balance; the payment's
   folder is emptied first (the provisional PDF disappears). Files older than 7 days are deleted. The
   message to the customer is in the app/receipt language.
8. Share PDF is only on the WhatsApp screen (PRD J-07: "SMS flow prepares link only").

**Open questions**

- Should the WhatsApp text be in the customer's language rather than the lineman's app language? (Today:
  the receipt language = app language, like the printed receipt.)
- Done-screen tiles could show "WhatsApp opened" as their state text after returning; not done (it needs
  more of T-066's Done screen).
- PDF via WhatsApp opens WhatsApp's contact picker (no undocumented `jid` extra is used). Field test whether
  linemen manage it; the wa.me link flow goes straight to the chat.

**Deviations / files outside the owned paths**

- `feature/collect/CollectDoneViewModel.kt` (T-066, done): new last constructor parameter
  `receiptActions: ReceiptActionRecorder = ReceiptActionRecorder.None` (Hilt injects the outbox) and the
  `printed` / `print_failed` record in `print()`. Payment untouched.
- `data/db/OutboxDaos.kt` (T-064, done): three read queries on `ReceiptActionDao` (`oldestSendable`,
  `countPending`, `get`). No schema change, no migration, identity hash unchanged.
- `ui/CableApp.kt`: the default `collectDone` slot passes `ReceiptShareActions` (WhatsApp / SMS → the share
  route), `receiptShareScreen(navController)` in the NavHost, `ReceiptShareRoute` in the Search tab's
  sub-screens. `CableApplication.kt`: inject + `receiptSync.start()`. `AndroidManifest.xml`: the FileProvider.
- `apps/android/README.md`, `packages/i18n/glossary.md`; regenerated `strings_generated.xml` (en/hi) and
  `apps/web/messages/{en,hi}.json`.
- Tests beside the owned paths: `app/src/test/.../data/receipts/`, `.../feature/receipt/`.

**Verification** (JDK 21, Android SDK, Node v24.21.0, pnpm 12.11.2, Postgres 17; no emulator)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test` (rebased on
  `feature/mvp` b213333): BUILD SUCCESSFUL. App JVM tests 323, 0 failures (40 new in `feature/today`);
  designsystem 31; detekt-rules 4; lint 0 errors, 2 existing warnings. The Today package was run several
  more times on its own and in the full suite. New tests:
  - `TodaySummaryTest` (6): cash and UPI apart and `MethodTotals` has no field for both; another lineman's
    held payments (cash and UPI) and yesterday's payments left out; **IST day boundaries** (23:59:59 IST is
    the day before 00:00 IST, also at the other end of the day); office totals + what the office does not
    list, cancelled counted nowhere, office-only payments listed; stored totals without a list → the phone's
    count; empty day.
  - `HandoverRulesTest` (5): discrepancy and reason tiles by sign; no reason when it matches with nothing on
    the phone; `pending_sync` when it matches the phone's count but cash is still on the phone (the contract's
    own ₹800 vs ₹700 example); a reason that fits the sign is required; note trimmed / capped; the handover
    state order (accepted final, then the phone's handover, then the office).
  - `TodayViewModelTest` (5): totals with held payments of another lineman left out, read-out text; the day
    is today in India time and moves after midnight on show; showing asks the office and sends a waiting
    handover, offline says so, the office's answer combines; on phone → submitted → sent back → accepted (no
    more handing over); signed out shows nothing.
  - `HandoverViewModelTest` (6): pre-fill = office cash + cash still on the phone (never UPI, never the held
    ₹900); matching → Confirm → request with `pending_sync` + unsynced count/cash, saved once on a double tap;
    short amount → reason tiles by sign, reason required, note; back from Confirm = new submission id;
    **process death** (new ViewModel on the same `SavedStateHandle`) keeps the step, the frozen plan and the
    submission id; offline plan; AlreadyAccepted / signed out.
  - `TodayRepositoryTest` (10, MockWebServer + `FakeHandoverOffice` with T-062's rules): the fixture day,
    stored totals for a later run; **offline → saved → sent once when online → cleared**; **timeout after
    the office saved it → resent with the identical body and id, one handover at the office**; 429 / 503 keep
    it waiting, a double tap saves once, a lost answer is cleared by the day showing the submission; **409
    HANDOVER_ALREADY_ACCEPTED → refused, never resent, day shows accepted, new handovers refused on the
    phone**; **sent back with a note → handed over again → accepted**; VALIDATION (office total differs) →
    refused, then a new handover goes through; another lineman's saved handover never sent; the contract's
    `submitHandover` fixtures; a slow day check racing a handover → the newer answer is kept.
  - `HandoverSyncWorkerTest` (6, WorkManager test driver, file-backed Room): **kill the app right after
    saving offline → after restart it is sent exactly once**; killed after the office saved it but before the
    phone stored the answer → one handover; APP_TOO_OLD → failure, kept; signed out → success, kept; unique
    work `handover-sync` with CONNECTED, exponential 30 s, at most one waiting; **payments go first** (the
    office's expected cash then counts them, no discrepancy); no payment push without a handover.
  - `TodayFlowTest` (2, Compose UI on Robolectric, Hindi, 360 × 800 dp, real `CableApp` NavHost, real
    ViewModels and repository, in-memory Room, MockWebServer): Today ₹800 cash / ₹450 UPI on separate tiles,
    "4 पेमेंट", "1 पेमेंट सिर्फ़ फ़ोन में है", "ऑफिस में", no ₹900 (held) and no ₹1,250 (mixed) anywhere,
    totals read aloud → Hand over: "कितना कैश होना चाहिए ₹800", "₹700 ऑफिस में + ₹100 फ़ोन में" → ₹750 → "₹50
    कम" → reason tiles (no "extra"), Next disabled until chosen → Confirm read aloud → Today "फ़ोन में सेव…",
    nothing on the card says "ऑफिस पहुँच गया" → payment then handover sent → "ऑफिस पहुँच गया", "जाँच बाकी",
    "₹50 कम" → sent back "ऑफिस ने कहा: फिर से गिनें" → hand over again (matches, no reason) → accepted, no
    button. Offline: "इस फ़ोन में गिना", ₹600 cash, waits on the phone with `pending_sync`. Every tappable
    ≥ 56 dp on each screen.
- Root (Node v24.21.0, pnpm 12.11.2, Postgres 17): `pnpm install --frozen-lockfile`, `pnpm lint`,
  `pnpm typecheck` (10/10), `pnpm test` (10/10 incl. DB tests), `pnpm build` (10/10), `pnpm generate` (no
  diff), `tokens:build --check`, `icons:build --check`, `i18n:check`, `i18n:build --check`,
  `openapi:build --check`, `node scripts/tasks.mjs check --local`: all pass.

**Still needs a real phone**

- **PdfDocument output** (Robolectric has no PDF engine, so tests draw the same page on a bitmap): open the
  shared PDF in WhatsApp and a PDF viewer on Android 8 (API 26) and 14+; Hindi shaping, page size, file name
  `Receipt-R-….pdf`.
- **FileProvider grants:** WhatsApp receives the PDF on API 26 and 34+ (direct `setPackage` and through the
  chooser); the chooser shows when WhatsApp is missing.
- **wa.me with `setPackage`:** WhatsApp and WhatsApp Business installed / only one / none (→ "WhatsApp is
  not on this phone"); the chat opens on the confirmed number with the Hindi text intact.
- **SMS:** `smsto:` opens the default SMS app (Google Messages, Samsung, Xiaomi) with the body prefilled; a
  phone without an SMS app (tablet) shows the problem.
- Background: kill the app after tapping Open WhatsApp offline, reconnect → the link is made and the action
  is recorded once; Doze / OEM savers delaying `receipt-sync`.
- Server: `PATCH /customers/{id}/phone` (T-060) once deployed; a real `POST /receipts/{id}/link` with an
  https `RECEIPT_BASE_URL`.
- Hindi review (H-03): `mobile_receipt` `_review` and the new glossary rows.

## Board log

- 2026-10-13T20:26:00.144Z claimed by agent-t070
- 2026-10-14T04:31:48.176Z completed on task/T-070-android-today-screen-and-cash-handover
