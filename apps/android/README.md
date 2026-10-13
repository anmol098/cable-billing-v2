# Cable Billing lineman app (Android)

Kotlin + Jetpack Compose app for linemen (PLAN §11). Package `com.cablebilling.lineman`
(provisional, D-21 / H-02). minSdk 26, targetSdk 36, compileSdk 37.

## Requirements

- **JDK 17 or newer** to build (Gradle 9.8 and AGP 9.4 run on 17+). The unit tests run Robolectric
  at API 36, whose Android runtime needs **JDK 21**; use JDK 21 for `test*UnitTest` (Android Studio's
  bundled JDK is fine).
- **Android SDK** with platform `android-37` and build-tools 36 (AGP downloads missing ones by itself
  when the SDK licences are accepted: `sdkmanager --licenses`). Point Gradle at the SDK with
  `ANDROID_HOME` or `sdk.dir` in `local.properties`.
- No Node.js: the generated files (tokens, icons, strings) are committed.

## Commands

Run from `apps/android`:

```bash
./gradlew assembleDevDebug           # debug APK for the dev flavour
./gradlew testDevDebugUnitTest       # JVM + Robolectric tests (incl. Compose UI tests)
./gradlew ktlintCheck detekt lint    # style, static analysis, Android lint
./gradlew ktlintFormat               # fix ktlint issues
./gradlew :detekt-rules:test         # tests for the project's own detekt rules
```

The full local check (same as tasks/README.md §3.5):
`./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug`.

## Flavours

| Flavour | applicationId | API base URL (BuildConfig.API_BASE_URL) |
|---|---|---|
| `dev` | `com.cablebilling.lineman.dev` | `http://10.0.2.2:3000/api/mobile/v1/` (local Next.js via the emulator; cleartext allowed only for 10.0.2.2 / localhost) |
| `staging` | `com.cablebilling.lineman.staging` | `https://staging.cablebilling.example/api/mobile/v1/` (placeholder until H-02) |
| `prod` | `com.cablebilling.lineman` | `https://app.cablebilling.example/api/mobile/v1/` (placeholder until H-02) |

Override a URL with `-Pcb.apiBaseUrl.<flavour>=…` (e.g. a phone on the same Wi-Fi as your laptop).
Sentry is off unless the flavour has a DSN: `-Pcb.sentryDsn.<flavour>=…` or `SENTRY_DSN_<FLAVOUR>`
(staging and prod also take the shared `-Pcb.sentryDsn` / `SENTRY_DSN`; dev never does, so local builds and
unit tests send nothing). It lands in `BuildConfig.SENTRY_DSN`.

## Layout

```text
app/                      the app: feature packages under com.cablebilling.lineman
  feature/{login,update,search,customer,collect,waiting,today,…}   one package per feature (PLAN §11.1)
  data/network            Retrofit services, interceptors, generated DTOs (data/network/generated)
  data/auth               session store (Tink-sealed), install id, sign in / out
  data/db                 Room database (roster cache, payment queue, outboxes, sync_meta), repositories
  data/payments           payment queue: save (UUIDv7 + P-ref, commit before "Saved"), receipts (T-066)
  data/sync               roster sync (RosterSync*) and payment push (PaymentSync*): engine, worker, scheduler
  ui/                     app shell (CableApp: bottom bar + NavHost), navigation
  di/                     Hilt modules (network, storage)
  locale/                 AppLanguage (Hindi default, per-app language)
  diagnostics/            diagnostic log (no personal data), app report, CrashReporting (Sentry) + scrubbing
  schemas/                Room exported schemas (committed; one JSON per database version)
core/designsystem/        GENERATED Tokens.kt + ic_cb_* icons, CableTheme, fonts, components
                          (component/), Rupees formatting (money/), Speaker (voice/)
app/src/debug/            debug-only component catalogue (second launcher icon "Components (test)")
detekt-rules/             project detekt rules (no raw Color(0x…) / .dp / .sp outside core/designsystem)
config/detekt, config/lint  shared static-analysis config
gradle/libs.versions.toml version catalog (append-only shared file)
```

Generated, never edited by hand: `core/designsystem/.../generated/Tokens.kt` (`pnpm tokens:build`),
`core/designsystem/src/main/res/drawable/ic_cb_*.xml` (icons), and
`app/src/main/res/values*/strings_generated.xml` (`pnpm i18n:build`).

## API, sign-in and force update (T-063)

- `app/.../data/network/generated/ApiModels.kt`: **generated** DTOs (kotlinx.serialization) from
  `packages/contracts/openapi.json`. Never edit it. The generator is plain Kotlin in the unit-test
  source set (`data/network/codegen/ApiModelGenerator.kt`); `ApiModelsUpToDateTest` fails when the
  file is stale. After a contract change:
  `./gradlew :app:testDevDebugUnitTest --tests '*ApiModelsUpToDateTest' -Pcb.writeApiModels=true`.
- `MobileApi` (every bearer endpoint) and `AuthApi` (login, refresh, logout): Retrofit, written by
  hand against the contract. Wrap calls in `apiCall(errors) { … }` to get an `ApiResult`.
- Every request sends `x-app-version-code`; the authenticated client adds the bearer token and
  refreshes it once on UNAUTHENTICATED (single flight). The session (tokens, user, operator, device)
  is sealed with the Keystore-backed Tink key in the `session` DataStore.
- The network tests run against MockWebServer with the contract fixtures in
  `packages/contracts/fixtures` (no server needed); those files are inputs of the test task.

## Offline roster and the Room database (T-064)

- `data/db/CableDatabase` (Room, file `cable.db`): `customers`, `customer_vcs`, `open_bills` (roster
  cache), `payments` (local queue, never deleted), `receipt_actions_outbox`, `collection_day`,
  `sync_meta`. Money is `Long` paise; instants are epoch-ms `Long` (`*_at`), dates `YYYY-MM-DD` text.
- `RosterRepository`: `search(query)` and `customer(id)` Flows (offline, projected balance = server
  balance minus the phone's unsynced payments), `refreshCustomer(id)` (online detail), and
  `syncStatus()` for "Updated X min ago".
- `RosterSync` pulls `GET /sync/customers` (full, then deltas by cursor; CURSOR_INVALID → full);
  `RosterSyncScheduler` runs it every 30 min, on sign-in, on app open and on `requestNow()`.
- **Changing the schema:** bump `CableDatabase.VERSION`, add a `Migration` to `CableMigrations.ALL`,
  build (Room writes `schemas/…/<version>.json`; commit it), add the new identity hash to
  `CableDatabaseMigrationTest`. Never use a destructive fallback: payments may exist only on the phone.
  Debug builds carry the schema JSONs as assets so `MigrationTestHelper` runs under Robolectric.

## Search home and customer screen (T-065)

- `feature/search`: `SearchScreen` (home, D-11): sync strip, the digits typed, result rows (due large and
  red) and the big `NumberPad`; its ABC key switches to the phone's keyboard (name search), `123` back.
  `SearchViewModel` debounces typing (50 ms on the pad, 200 ms on the keyboard) and reads `SearchData`
  (`RosterSearchData` = `RosterRepository` + `RosterSyncScheduler`). `SearchBanner` turns
  `RosterSyncStatus` into the strip ("Updated 5 min ago", "3 payments on phone" → opens Waiting).
- `feature/customer`: `CustomerScreen(customerId, onCollect, onBack)` + `CustomerViewModel` (assisted
  `customerId`): cached copy at once, `refreshCustomer` on open, due huge, credit apart, tap-to-call
  (`ACTION_DIAL`), connections, read-out "name, ₹X due" (`SpeakOnShow`), giant Collect button.
- Navigation (`ui/CableApp`): `SearchRoute` → `CustomerRoute(customerId)` → `CollectRoute(customerId)`
  → `CollectDoneRoute(paymentId)`, all on the Search tab (it stays highlighted; tapping it returns home).
  `CableApp(searchHome = …, customerScreen = …, collectScreen = …, collectDone = …, waitingScreen = …)`
  lets tests run the shell without Hilt.

## Collect flow, payment queue and push (T-066)

- `feature/collect`: `CollectScreen` (one destination, steps Amount → Method → UPI ref → Confirm in
  `CollectViewModel`, all in `SavedStateHandle`), then `CollectDoneScreen` (`CollectDoneRoute`, which
  replaces the flow on the back stack: Back from Done never reaches Save again). Amount is pre-filled
  with the due (rounded up to whole rupees), quick chips full due / ₹100 / ₹200 / ₹500, number pad
  (the first key after a pre-fill or chip types a new amount, max ₹99,99,999). Confirm reads "name से
  ₹X नकद" aloud; Save is enabled once and the screen moves to Done only after Room committed.
- `data/payments/PaymentRepository.save(draft)`: the draft carries a UUIDv7 made when Confirm opened
  (kept across process death, so a second Save is the same payment); the provisional reference
  `P-{device_code}-{seq}` is taken inside the insert's transaction; the push is requested after the
  commit. Rows are never deleted (`PaymentDao` has no delete/replace).
- `data/sync/PaymentSync` pushes `POST /payments:batch`: only the signed-in lineman's own payments
  (another lineman's stay held, PLAN §9.2), oldest first, 50 per batch. Outcomes: posted / duplicate
  / posted_needs_review → `SENT_TO_OFFICE` + permanent receipt number (+ review reason);
  rejected → `NEEDS_OFFICE_HELP`; retry_later, missing result, offline, 429/5xx, unreadable answer →
  stays `SAVED_ON_PHONE` (retry with backoff, no limit); APP_TOO_OLD / signed out / other refusals →
  stays, the next trigger tries again. A retry after a lost answer resends the same ids → duplicates.
- `PaymentSyncWorker` + `PaymentSyncScheduler`: unique work `payment-sync` (APPEND_OR_REPLACE, at most
  one waiting run), `NetworkType.CONNECTED`, exponential backoff from 30 s; triggered after every save,
  on sign-in, on app open (`start()` in `CableApplication`) and by "Try now". A push that posted
  anything asks for a roster pull (`RosterSyncScheduler.requestNow()`).
- `feature/waiting`: the Waiting tab: problems first (Call office), payments on the phone, another
  lineman's held payments (flagged, Call office), last push status in honest words, "Try now".

## Settings, diagnostics and crash reporting (T-071)

- `feature/settings`: `SettingsRoute` opened by the small gear (`SettingsButton`) at the end of the search
  home's query row; it sits on the Search tab's stack. Language हिंदी / English (`AppLanguage.set`, kept by
  the per-app language API), voice on/off (`VoiceToggle` on the shared `Speaker`), printer name +
  "Set up printer" (`PrinterSetupRoute`), sign out, app version, "Share app report".
- **Sign-out** is refused while the signed-in lineman has payments on the phone
  (`PaymentDao.oldestSavedOnPhoneFor(userId, 1)`; another lineman's held payments and refused ones do not
  block it). The screen says how many, that they are safe, and offers "Try now" and "Open Waiting"; the
  check runs again at "Yes, sign out". Sign-out never deletes a payment (`SignOutKeepsPaymentsTest`).
- `diagnostics/DiagnosticLog`: a ring buffer on disk (`noBackupFilesDir/diagnostics`, 64 KiB cap, two
  files) of `snake_case` events with codes and counts. Every line goes through `PiiScrubber`; exceptions
  are logged as types and stack frames only (never messages). `DiagnosticsRecorder` writes app start,
  session changes, payment-push results and crashes. Write your own events with
  `log.info("event_name", "key=value …")`, never names, phone numbers, amounts or tokens.
- "Share app report" opens the share sheet with `DiagnosticReport` (app, phone model, queue counts, the
  log) as plain text. The app only knows the sheet was opened, never that anything was sent.
- `CrashReporting` + `SentryPrivacy`: Sentry with `sendDefaultPii = false`, no screenshots or view
  hierarchy, no tracing; `beforeSend` / `beforeBreadcrumb` scrub messages, exception values, breadcrumbs,
  extras and tags and drop the request, server name, device name and all user fields but Sentry's random
  install id. Never started under Robolectric.

## Design-system components

`core/designsystem/.../component/` holds the low-literacy kit (BigButton, MethodButton, NumberPad,
AmountDisplay, StatusChip, CustomerRow, SyncBanner, ConfirmCard, ReceiptActionTile, SpeakButton,
VoiceToggle). Components take their words as parameters; screens pass `stringResource(...)`. Debug
builds have a catalogue of all of them in Hindi and English: open the "Components (test)" launcher
icon, or `adb shell am start -n com.cablebilling.lineman.dev/com.cablebilling.lineman.catalogue.ComponentCatalogueActivity`.
The module's own tests (`./gradlew :core:designsystem:testDebugUnitTest`) also run as part of
`testDevDebugUnitTest`.

## Bluetooth receipt printing (T-068)

`app/.../printing/`: receipts are drawn with the bundled fonts on a 384-dot-wide bitmap (58 mm), so
Hindi prints on printers without Devanagari (D-08), then sent as ESC/POS raster (`GS v 0`, in bands)
over Bluetooth SPP. Inject `ReceiptPrinter` and call `print(receiptModel)`: it never throws and
returns `PrintResult.Printed` or `PrintResult.Failed(problem)` (show and speak `problem.message`).
Printer setup is the `PrinterSetupRoute` screen (`feature/printer`).

- No real printer in CI: the transport is behind `PrinterTransport` / `SppSocketFactory` and tested
  with fakes. Test on real printers before release (see the T-068 task notes).
- Renderer snapshots: `app/src/test/resources/receipt-snapshots/*.png` are the golden receipts
  (Robolectric native graphics, thresholded to printer dots). After an intended layout change:
  `./gradlew :app:testDevDebugUnitTest --tests '*ReceiptRendererSnapshotTest' -Pcb.writeReceiptSnapshots=true`,
  look at the new PNGs and commit them.

## Fonts

`core/designsystem/src/main/res/font/`: Inter and Noto Sans Devanagari, Regular (400) and
SemiBold (600) static instances from Google Fonts, under the SIL Open Font License 1.1
(licence texts in `core/designsystem/src/main/assets/licenses/`, shipped in the APK).
