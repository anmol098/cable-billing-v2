---
id: T-068
title: Android: Bluetooth printer setup and ESC/POS raster printing
phase: 3
area: android
status: done
owner: agent-t068
claimed_at: 2026-10-13T12:48:22.654Z
branch: task/T-068-android-bluetooth-printer-setup-and-esc
depends_on: [T-009]
review: self
claimable_by: agent
size: L
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/printing/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/printer/**, apps/android/app/src/main/AndroidManifest.xml, packages/i18n/messages/*/mobile_printer.json]
---

# T-068 — Android: Bluetooth printer setup and ESC/POS raster printing

**Phase** 3 · **Area** android · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-009

## Goal

Print readable Hindi + English receipts on generic 58 mm printers.

## Scope

- Permissions per API level with icon-led explainer; printer setup (paired list, scan, pair, test print, remember).
- `ReceiptRenderer`: draws a `ReceiptModel` to a 384px-wide bitmap with bundled fonts.
- `EscPosRasterEncoder` (`GS v 0`, chunked) + RFCOMM SPP transport with timeouts; printer profiles (init/feed/cut).
- Errors surfaced as typed results (off, no paper, not paired) – never throws into payment code.

## Acceptance criteria

- [ ] Test print works on at least one real 58 mm ESC/POS printer (record model in completion notes).

## Tests required

- Unit tests: encoder byte output for a tiny bitmap; renderer snapshot test.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/printing/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/printer/**`
- `apps/android/app/src/main/AndroidManifest.xml`
- `packages/i18n/messages/*/mobile_printer.json`

## References

PLAN §11.8, FR-018, D-08, RULE-18 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**Acceptance criterion not met here:** the real-printer test print. This container has no Bluetooth
and no printer (and no emulator), so the box above stays unticked. Everything up to the Bluetooth
socket is tested with fakes and Robolectric; the on-device plan is at the end of these notes.

**What exists** (`apps/android/app/src/main/java/com/cablebilling/lineman/…`)

- `printing/receipt/`: `ReceiptModel` (what a receipt says), `ReceiptContent` (model → lines in one
  language), `ReceiptDocument` / `ReceiptLine` (`Text`, `Field` label+value, `Amount`, `Rule`),
  `ReceiptStrings` (all printed words from `mobile_printer` strings, loaded for a given language
  whatever the app language is), `ReceiptLanguage` (Hindi / English, `current()` = app language),
  `ReceiptDates` (IST date/time, `12 अक्टू 2026, 4:05 PM`; month names copied from
  `packages/domain/src/time/labels.ts`, a test reads that file and fails on drift).
- `printing/render/`: `ReceiptRenderer` (draws a document black on white, `render(doc, widthDots)` →
  Bitmap, `draw(canvas, doc, widthDots)` → height used), `ReceiptFonts` (bundled Noto Sans Devanagari
  400/600 for all text, so a Hindi name prints on an English receipt too; Inter 600 for the amount),
  `ReceiptMetrics` (sizes in printer dots derived from tokens: 1 sp = 203/160 dots, so print is as big
  as on screen; body ≈ 23 dots ≈ 2.9 mm, amount ≈ 56 dots), `MonoBitmap` (threshold to dots, pack rows).
- `printing/escpos/`: `EscPosRasterEncoder` (`GS v 0` per band of whole rows, at most
  `maxBytesPerChunk` data bytes each; `encode(image, profile)` → `PrintJob(start, chunks, end)`),
  `EscPos` (`ESC @`, `ESC d n`, `GS V 66 0`, `DLE EOT 4` + a strict paper-status parser),
  `PrinterProfile` (`Generic58` default: 384 dots, no cutter, 4 feed lines, 2048-byte chunks, 20 ms
  pause, paper check, 500 ms drain; `Generic58Cutter`; `Generic80` 576 dots).
- `printing/transport/`: `PrinterTransport` / `PrinterLink` interfaces, `SppTransport` (RFCOMM SPP,
  UUID `00001101-0000-1000-8000-00805F9B34FB`; a watchdog closes the socket when the connect (8 s) or a
  chunk write (10 s) takes too long → `PrinterTimeoutException`; refused secure socket → one try with
  the insecure one → `PrinterUnreachableException`; status reads poll `available()`, 400 ms).
- `printing/bluetooth/`: `BluetoothPrinters` (availability, permissions, paired list with likely
  printers first, `find()` flow, `pair()`), `AndroidBluetoothPrinters`, `AndroidSppSockets`,
  `PrinterPermissions` (per API level).
- `printing/`: `ReceiptPrinter` (interface) + `BluetoothReceiptPrinter`, `PrintResult` /
  `PrintProblem`, `PrinterSettings` + `DataStorePrinterSettings` (`printer_address`, `printer_name`,
  `printer_profile` in the `settings` DataStore), `PrintingModule` (Hilt).
- `feature/printer/`: `PrinterSetupRoute` (nav route), `PrinterSetup(onBack)` (screen + ViewModel +
  permission / Bluetooth-enable launchers), `PrinterSetupScreen` (stateless), `PrinterSetupViewModel`,
  `PrinterSetupUiState`, `PrinterSetupTags`.
- Manifest: `BLUETOOTH` / `BLUETOOTH_ADMIN` / `ACCESS_FINE_LOCATION` with `maxSdkVersion="30"`,
  `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN` (`neverForLocation`), `uses-feature bluetooth required=false`.
- i18n namespace `mobile_printer` (`setup.*`, `error.*`, `receipt.*`, `test.*`; all Hindi in `_review`),
  glossary rows (printer words), icon meaning `bluetooth` (Lucide `bluetooth`) → `ic_cb_bluetooth`.

**APIs for T-066 / T-069 / T-070 / T-071**

```kotlin
// Inject ReceiptPrinter (Hilt). Never throws (only coroutine cancellation), never touches payments.
when (val r = receiptPrinter.print(receiptModel /*, ReceiptLanguage.current() */)) {
    PrintResult.Printed -> record("printed")            // say: R.string.mobile_printer_setup_printed
    is PrintResult.Failed -> {                           // record("print_failed")
        show(r.problem.message)                          // @StringRes, also speak it (VoiceLines.line(id))
        // + R.string.mobile_printer_error_payment_safe ("The payment is saved. Only the printing failed.")
        if (r.problem.needsSetup) navController.navigate(PrinterSetupRoute)   // no printer / not paired / BT off / permission
    }
}
```

- `ReceiptModel(operatorName, operatorPhone?, number: ReceiptNumber.Permanent("R-…") |
  Provisional("P-…"), recordedAt: Instant (UTC), customerName, customerCode, amountPaise, method:
  Cash|Upi, upiReference?, linemanName, bills: List<ReceiptBill(month: YearMonth?, leftPaise)>,
  balanceAfter: ReceiptBalance.Due/Credit/Clear?, footer?)`. From the API: `bills` from
  `PostedPayment.allocations` (`period` YYYY-MM-01 → `YearMonth`, `kind = opening_balance` → `month =
  null`, `outstanding_after_paise` → `leftPaise`), `balanceAfter = ReceiptBalance.of(balance_after_paise,
  credit_after_paise)`, operator name / phone / footer from `session.operator`, lineman =
  `session.user.name`. A payment only on the phone: Provisional number, empty `bills`, null
  `balanceAfter` (the receipt guesses nothing; it says "Temporary no. The office will give the final no.").
- `PrintProblem`: `NoBluetooth`, `BluetoothOff`, `PermissionDenied`, `NoPrinterChosen`, `NotPaired`,
  `Unreachable` (off / out of range / busy), `Timeout`, `NoPaper` (only printers that answer
  `DLE EOT 4`), `ConnectionLost`, `Failed` (anything else, incl. OutOfMemoryError while rendering).
- PDF (T-069): `ReceiptContent.receipt(model, ReceiptStrings.load(context, language))` gives the same
  lines; `ReceiptRenderer(ReceiptFonts.load(context)).draw(pdfPage.canvas, document, widthDots)` draws
  them onto a `PdfDocument` page (pick a width in points; text sizes are in the same units).
- Setup screen: `navController.navigate(PrinterSetupRoute)`; it is registered in `CableApp`'s NavHost.
  Saved printer: inject `PrinterSettings` (`printer: Flow<SavedPrinter?>`), e.g. to show its name in
  settings (T-071).

**Decisions**

1. **Raster only**, never ESC/POS text, so every printer prints the same picture and Hindi works
   (D-08). The test page carries Hindi and English samples and a ₹1,23,456 amount.
2. **Bands of whole rows** (one complete `GS v 0` per chunk) rather than one big command split at
   arbitrary bytes: each write is self-contained, and a printer that drops a write loses one band, not
   the rest of the receipt. Pause between chunks and a drain wait before closing are per profile.
3. **Paper check is optional and strict**: `DLE EOT 4` is asked after `ESC @`; only a byte with the
   status fixed bits counts, and "paper end" stops before any picture is sent. No answer = print.
4. **Sizes from tokens**: printer dots = sp × 203/160 (`ReceiptMetrics`), so there are no new
   tokens and no hard-coded type sizes. Colours on paper are only black and white.
5. **One font for all text** (Noto Sans Devanagari has Latin), Inter only for the big amount:
   deterministic output on every phone, no reliance on system fallback fonts.
6. **Receipt language** = app language by default (`ReceiptLanguage.current()`), a parameter for
   later (e.g. a per-customer choice). 12-hour time with "AM/PM" words from strings.
7. **Choosing a printer prints the test page at once** (one tap = choose + check). After pairing a
   found printer the same happens. Results are shown with icon + colour + words and spoken.
8. **Profile**: stored with the printer, default `Generic58`; there is no UI to change it yet
   (low-literacy screen). Change it in code/DataStore after real-printer testing if needed.
9. **Snapshot test** compares thresholded printer dots with committed golden PNGs
   (`app/src/test/resources/receipt-snapshots/`, reviewable images) rather than only a hash; the
   failure message prints the SHA-256 and the differing-dot count. Update:
   `./gradlew :app:testDevDebugUnitTest --tests '*ReceiptRendererSnapshotTest' -Pcb.writeReceiptSnapshots=true`.
   Robolectric `@GraphicsMode(NATIVE)` shapes Devanagari properly (conjuncts, matras).

**Deviations / changes outside the owned paths**

- `ui/CableApp.kt` (T-008, done): one `composable<PrinterSetupRoute>` line + imports, so later tasks
  can navigate to setup without editing the shell.
- `app/build.gradle.kts` (§6 shared, appended): `packages/domain/src/time/labels.ts` declared as a
  test input; `-Pcb.writeReceiptSnapshots` passed to tests.
- `packages/design-tokens/icons.json`: `bluetooth` (+ regenerated `ic_cb_bluetooth.xml`,
  `packages/ui/src/icons/icons.generated.ts`). `packages/i18n/glossary.md`: printer words.
  Regenerated `strings_generated.xml` (en/hi) and `apps/web/messages/{en,hi}.json`.
- `apps/android/README.md`: a printing section.

**Follow-ups (no task files created)**

- **H-05 / real-printer testing (required before release)**, then publish `docs/printers.md` (PLAN
  §11.8). Printers to try: a generic "MTP-II"/"MTP-3" 58 mm, Rongta RPP02N, a "PT-210"/Goojprt,
  Xprinter XP-P300 / XP-P323B, a Hoin/Zjiang 58 mm, and one 80 mm cutter printer. For each check:
  pairing (PIN 0000/1234) and the first connect; test page Hindi is sharp and readable at normal print
  density; whole receipt prints with no gaps between bands (else lower `maxBytesPerChunk` or raise
  `chunkPauseMillis`); the end is not cut off (else raise `drainMillis`); feed length clears the tear
  bar; whether it answers `DLE EOT 4` and "no paper" shows; printer off → "Printer not found" within
  ~8 s; printer switched off mid-print → "stopped in the middle"; two prints in a row; API 26–30 phone
  (location prompt, discovery needs location switched on) and API 31+ phone (Nearby devices).
- On API 26–30, discovery finds nothing while the phone's location switch is off; we only say "No
  printer found. Is it on and close by?". A hint to turn location on could be added after field tests.
- No UI to pick a printer profile (58 mm with cutter / 80 mm); add one if the field needs it.
- Hindi review (H-03): `mobile_printer` `_review` (59 keys) and the new glossary rows.

**Verification** (JDK 21, Android SDK, Node v24.21.0, pnpm 12.11.2; no Bluetooth, no emulator)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`: BUILD
  SUCCESSFUL. app 149 JVM tests (59 new), designsystem 31, detekt-rules 4, 0 failures. Lint 0 errors,
  2 existing warnings (`MissingApplicationIcon`, `AppBundleLocaleChanges` — the latter now also
  points at `ReceiptStrings`, same follow-up as T-067).
- New tests: `EscPosRasterEncoderTest` 7 (exact bytes for a 10×3 bitmap, banding by byte limit, 384-dot
  bands 42/42/16, 16-bit row count, reset/feed/cut per profile, too-wide refused, paper-status parser),
  `MonoBitmapTest` 3, `ReceiptContentTest` 7 (full English and Hindi receipts line by line,
  provisional = temporary note and no guessed bills/balance, IST + 12-hour edges, no
  "invoice/tax/sent/delivered" words), `ReceiptDatesTest` 3 (month names = `packages/domain`),
  `ReceiptRendererSnapshotTest` 7 (4 golden receipts, deterministic, 384/576 wide, Devanagari glyphs and
  conjuncts shaped, long names wrap, `draw` height, real receipt → `GS v 0` bands whose row total =
  rendered height), `BluetoothReceiptPrinterTest` 9 (bytes on the wire, cutter, no paper stops before
  the picture, every failure typed, bugs/OOM never escape, test page to the given printer),
  `SppTransportTest` 6 (real threads: hanging connect/write time out and close the socket,
  secure→insecure fallback, unreachable), `PrinterSettingsTest` 2 (survives restart),
  `AndroidBluetoothPrintersTest` 4 (permissions per API, nothing without permission, printers first,
  API 26 prints without runtime permission), `PrinterSetupScreenTest` 11 (Hindi: explainer before the
  prompt, blocked → settings, Bluetooth off / missing, all tappables ≥ 56dp and main buttons ≥ 64dp,
  choose → saved + test page + spoken, failure shown + spoken + retry, find → pair → print, failed
  pairing, nothing found, finding permission explainer).
- The snapshot test fails for real: changing `ReceiptMetrics.edge` made it fail with the new size and
  hash; reverted.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm generate` (no diff), `tokens:build --check`, `icons:build --check`, `i18n:build --check`,
  `i18n:check`, `node scripts/tasks.mjs check --local`: all pass.
- **Not verified:** printing on a real printer (acceptance criterion), real pairing / discovery / the
  permission dialogs on API 26–30 and 31+ phones, and how the setup screen looks on a real screen.

## Board log

- 2026-10-13T12:48:22.654Z claimed by agent-t068
- 2026-10-13T13:32:53.245Z completed on task/T-068-android-bluetooth-printer-setup-and-esc
