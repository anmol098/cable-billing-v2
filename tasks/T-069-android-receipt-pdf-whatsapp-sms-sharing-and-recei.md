---
id: T-069
title: Android: receipt PDF, WhatsApp/SMS sharing and receipt actions
phase: 3
area: android
status: done
owner: agent-t069
claimed_at: 2026-10-13T20:48:51.202Z
branch: task/T-069-android-receipt-pdf-whatsapp-sms-sharing
depends_on: [T-066, T-068]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/receipt/**, apps/android/app/src/main/java/com/cablebilling/lineman/data/receipts/**, apps/android/app/src/main/res/xml/file_paths.xml, packages/i18n/messages/*/mobile_receipt.json]
---

# T-069 — Android: receipt PDF, WhatsApp/SMS sharing and receipt actions

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-066, T-068

## Goal

Give the customer a receipt without ever claiming delivery.

## Scope

- Wire Done-screen tiles: Print (T-068), WhatsApp (confirm/edit phone → wa.me link with preview URL; 'Share PDF' via FileProvider), SMS (`smsto:` with link).
- Local PDF via `PdfDocument` (works offline with provisional no.; regenerate after sync).
- Phone change from receipt flow → `PATCH /customers/{id}/phone` (queued if offline).
- Receipt actions outbox → `/receipts/actions:batch`; states limited to printed/print_failed/whatsapp_opened/sms_opened/pdf_shared.
- Offline link request queued with 'Link will be ready after sync' message.

## Acceptance criteria

- [x] No UI string or state says 'sent' or 'delivered' for messages (PRD §15 #11).
- [x] Print/share failure never changes payment state (PRD §15 #10).

## Tests required

- Unit tests for intent construction and outbox; UI test for phone confirm.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/receipt/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/receipts/**`
- `apps/android/app/src/main/res/xml/file_paths.xml`
- `packages/i18n/messages/*/mobile_receipt.json`

## References

PLAN §11.7, FR-017–FR-020, FR-004, J-07, RULE-18, RULE-19 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

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

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`: BUILD
  SUCCESSFUL. App JVM tests 315, 0 failures (32 new). Lint: 0 errors; warnings are the existing
  `MissingApplicationIcon` and `AppBundleLocaleChanges` (now also pointing at `ReceiptMessages`, same
  per-app-language follow-up as T-067/T-068). The receipt test classes were rerun twice more (`--rerun`)
  and stayed green. A mutation check (sending actions whose payment is still on the phone) failed
  `ReceiptSyncTest` as expected and was reverted.
  New tests:
  - `ReceiptIntentsTest` (8): phone normalisation (`+91 98765-43210`, `0…`, `0091…`, landline / 9 digits /
    5-prefix / other country → null), display; wa.me URL with `91`, UTF-8 percent-encoded Hindi (only
    unreserved chars + `%XX`, spaces `%20`, `+` `&` `=` encoded, decodes back, `Uri.getQueryParameter`
    round-trip); WhatsApp → WhatsApp Business packages, never a browser; `smsto:` + `sms_body`; PDF intents
    (type, stream, ClipData, read grant, chooser last); message text in Hindi and English; the real
    `ActivityShareLauncher` with Robolectric's activity check (nothing installed → false; WhatsApp
    Business only → the second candidate opens); a throwing context → false.
  - `ReceiptPdfWriterTest` (3): provisional `Receipt-P-K7Q-0012.pdf` then permanent
    `Receipt-R-2610-00045.pdf` replaces it (the provisional file is gone), receipt-wide pages, the permanent
    one taller, ink on the page, white background; old PDFs cleaned up; FileProvider content uri.
  - `ReceiptSyncTest` (11, MockWebServer + file-backed Room + DataStore, "process death" = everything
    closed and rebuilt on the same files): actions wait for their payment, then go once with contract names
    and UTC instants; a lost answer resends the same ids and the office stores them once; rejected kept and
    never resent, retry_later stays pending then goes; offline keeps every action and the outbox survives a
    restart; recording never touches the payment; link: payment on the phone → queued without a server call
    → made after the push; at the office but offline → queued, survives restart, made later; reused, not
    reused within a day of expiry; phone change: same number → nothing, offline → queued, survives restart,
    sent once with `{ "phone": … }`, shown until the roster catches up; 404 / 501 → kept without backoff,
    VALIDATION → dropped; another lineman's queued work waits.
  - `ReceiptSyncWorkerTest` (4): phone change taken → success + roster pull; nothing → success, no pull;
    offline → retry, APP_TOO_OLD → failure, signed out → success with the change kept; unique work
    `receipt-sync`, CONNECTED, exponential 30 s, one waiting run, nothing enqueued when nothing is queued.
  - `ReceiptShareScreenTest` (3, Compose on Robolectric, Hindi, 360 × 800 dp, real queues, fake office):
    **phone confirm** — stored number "98765 43210", "क्या यह ग्राहक का नंबर है?", Change → pad, a 5-prefix
    number cannot be used, 11th digit ignored, "यह नंबर लें" → new number shown and queued; offline "इंटरनेट
    आने पर लिंक तैयार होगा।" with Open WhatsApp disabled; Share PDF offline → WhatsApp first, chooser last,
    "PDF शेयर किया", `pdf_shared`; internet back → push, receipt sync → phone change at the office, "रसीद का
    लिंक तैयार है"; no WhatsApp → "इस फ़ोन में WhatsApp नहीं है…" + "पेमेंट सेव है…", payment row identical;
    WhatsApp → `wa.me/919123456780?text=…रसीद R-2610-00045…https://…` in `com.whatsapp`, "WhatsApp खुल गया",
    `whatsapp_opened`; payment row identical. SMS with no stored number → typed, link at once, no SMS app →
    problem, nothing recorded, payment identical → SMS opened (`smsto:7000012345`, body ends with the link),
    `sms_opened`, no "sent/भेजा/डिलीवर" on screen. Back while typing returns to the stored number; confirm
    without change queues nothing. Every tappable ≥ 56 dp.
  - `HonestReceiptWordsTest` (2): every `mobile_receipt_*` string plus the shown "opened" words, English
    and Hindi, contain no sent / send / delivered / भेज / डिलीवर / पहुँच गया / मिल गया; the action, outbox,
    opened, problem and link states have no such names; the action set is exactly the five observable ones.
  - `PrintActionsTest` (1): Done-screen print failure → `print_failed`, success → `printed`, sync asked
    twice, payment row identical (PRD §15 #10).
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (incl. DB tests on
  Postgres 17), `pnpm build`, `pnpm generate` (no diff), `tokens:build --check`, `icons:build --check`,
  `i18n:check`, `i18n:build --check`, `openapi:build --check`, `node scripts/tasks.mjs check --local`:
  all pass.

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

- 2026-10-13T20:48:51.203Z claimed by agent-t069
- 2026-10-14T04:37:28.197Z completed on task/T-069-android-receipt-pdf-whatsapp-sms-sharing
