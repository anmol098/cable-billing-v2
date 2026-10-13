---
id: T-065
title: Android: number-pad search home and customer screen
phase: 3
area: android
status: done
owner: agent-t065
claimed_at: 2026-10-13T13:38:58.502Z
branch: task/T-065-android-number-pad-search-home-and-custo
depends_on: [T-064, T-009]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/search/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/customer/**, packages/i18n/messages/*/mobile_search.json]
---

# T-065 — Android: number-pad search home and customer screen

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-064, T-009

## Goal

Find any customer with digits only and see what they owe at a glance.

## Scope

- Home = search with big NumberPad (code / phone part / VC number), ABC key for name search, SyncBanner.
- Result rows with large red due.
- Customer screen: name, code, area, tap-to-call, connections count, huge due, credit, giant Collect button, SpeakButton + auto speak 'name, ₹X due' via `Speaker`.

## Acceptance criteria

- [ ] Typing 4 digits returns results in < 100 ms on a 7.6k-customer roster on a low-end emulator profile.
  *Not ticked: no emulator in this container (no /dev/kvm). Measured on Robolectric/JVM SQLite with 7,616
  customers: query median 10 ms, key press → results in the ViewModel median 9–11 ms after the 50 ms
  number-pad debounce (≈ 60 ms in all). The emulator / phone measurement is left for a human (see notes).*

## Tests required

- ViewModel tests; Compose UI test for search → customer.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/search/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/customer/**`
- `packages/i18n/messages/*/mobile_search.json`

## References

PLAN §11.2, PLAN §11.3 (Search, Customer), D-10, D-11 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`apps/android/app/src/main/java/com/cablebilling/lineman/…`; overview in `apps/android/README.md`)

- `feature/search`: `SearchScreen(onOpenCustomer, onOpenWaiting, modifier, viewModel = hiltViewModel())`
  and the stateless `SearchContent(state, onKey, onTextChange, onShowNumberPad, onBannerClick,
  onOpenCustomer)`. Layout top to bottom: `SyncBanner`, the digits typed (big, tabular) or the hint, the
  result rows (`CustomerRow`: name, code, area, due large and red / advance green with its word), and the
  big `NumberPad` (`NumberPadExtraKey.Letters("ABC")`). ABC swaps the pad for an auto-focused text field
  with the phone's keyboard (name search; back or `123` return to the pad, keeping only the digits).
  "No customer found" shows only after the search for what is typed has answered; a full list (50) says
  "Showing the first 50. Type more."
- `SearchViewModel(SearchData, SavedStateHandle)`: `state: StateFlow<SearchUiState>` (`mode`, `query`,
  `results`, `resultsFor`, `banner`), `onKey`, `onTextChange`, `onShowNumberPad`, `onRefresh`. Debounce
  `DIGITS_DEBOUNCE_MS` = 50 (pad), `LETTERS_DEBOUNCE_MS` = 200 (keyboard), 0 for a cleared query;
  `flatMapLatest` cancels older queries. Query and keyboard survive process death. Max 20 digits.
- `SearchData` (interface, `SEARCH_LIMIT` = 50) with `RosterSearchData` (`RosterRepository.search` /
  `syncStatus`, `RosterSyncScheduler.requestNow`), bound in `SearchDataModule` (ViewModelComponent).
- `SearchBanner.from(RosterSyncStatus)`: `PaymentsOnPhone(count)` (amber; tap opens the Waiting tab) wins;
  never synced → `FirstDownload` (syncing) / `NeverDownloaded`; else `Updated(minutesAgo, problem)` with
  `UpdateProblem.NoInternet` (`lastFailure == "offline"`) or `Failed`. Green only when fine and ≤ 60 min
  old (`STALE_MINUTES`; WorkManager never records a failure while offline, so age matters). Words via
  `SearchBanner.text()` ("Updated just now / 5 min / 2 hours / 3 days ago", "No internet · …"). Tapping
  the strip without payments waiting asks for a sync now.
- `rowAmountPaise` (row amount: due if > 0, else −credit, else 0; the phone's unsent payments already off).
- `feature/customer`: `CustomerRoute(customerId)` (`@Serializable`), `NavController.navigateToCustomer(id)`,
  `CustomerScreen(customerId, onCollect, onBack, modifier, viewModel)` / stateless `CustomerContent(state,
  onCollect, onCall, onBack)`, `CustomerViewModel` (`@HiltViewModel(assistedFactory = Factory)`,
  `Factory.create(customerId)`; `state: StateFlow<CustomerUiState>`, `refresh()`), `CustomerData` /
  `RosterCustomerData` (`customer(id)`, `refreshCustomer(id)`), `CustomerView`, `CustomerRefresh`
  (`Running/Done/NoInternet/Failed`), `CustomerDialer` (ACTION_DIAL, no CALL_PHONE permission),
  `CustomerTags`. Screen: ← Back + speak button, name, code, area, due huge and red (or "₹0 Nothing due"),
  "Including payments saved on phone" (amber clock) when the projection includes them, advance in green,
  honest "No internet" line when the refresh could not reach the office, connections count, one
  tap-to-call button per number (phone, alt phone), giant `BigButton` "पैसे लें / Collect" (tile height,
  bottom). Opening the screen shows the cached copy at once and calls `refreshCustomer` once.
- Voice: `CustomerUiState.voiceLine = VoiceLines.customerDue(name, duePaise)`; `SpeakOnShow` speaks it on
  entry (again only if the due changes), `SpeakButton(spokenText(line))` replays it. No ₹ or digits in speech.
- Strings: namespace `mobile_search` (search + customer words, 21 keys, plurals for counts/ages), Hindi in
  `_review`. Glossary: new "Search and customer words" table.

**For T-066 (collect) / T-070 / later**

- `ui/navigation/CollectRoute(customerId)` exists with a `PlaceholderScreen` (tag `screen_collect`) in
  `CableApp`; the Collect button navigates there. T-066: replace that `composable<CollectRoute>` with the
  Amount screen (read the due with `RosterRepository.customer(id)`), and add the next screens' route
  classes to `TopLevelDestination.Search.subScreens` in `CableApp.kt` so the Search tab stays highlighted.
- After a payment is saved, the search Flow and the customer Flow update by themselves (Room); the sync strip
  switches to "N payments on phone" (tap → Waiting tab, `WaitingRoute`).
- `CableApp(navController, searchHome, customerScreen)`: the two slots default to the Hilt screens; tests
  run the shell without Hilt by passing their own (see `CableAppNavigationTest`, `SearchToCustomerTest`).

**Decisions**

1. **Small data interfaces** (`SearchData`, `CustomerData`) in front of `RosterRepository` (a final class
   with Room/network deps), so ViewModel tests run on virtual time with fakes; the UI test uses the real ones.
2. **Debounce 50 ms on the pad** (taps are further apart, so it only merges very fast taps and keeps
   key → results well under 100 ms), 200 ms on the phone's keyboard.
3. **Navigation stays flat** (no nested graph): Customer and Collect are plain destinations above
   `SearchRoute`. The bottom bar treats them as part of the Search tab (`subScreens`), and tapping the
   already-selected tab pops back to its first screen (before, a tab tap from a sub-screen would have
   restored the same sub-screen through `restoreState`). Switching to Today and back keeps the customer
   open (multiple back stacks, as before).
4. **Customer ViewModel by assisted injection** (`hiltViewModel<VM, Factory>(key = id) { it.create(id) }`)
   rather than `SavedStateHandle.toRoute`: the id is a constructor argument, easy to test.
5. Row amount shows the advance (green) when nothing is due, so a customer with credit is not shown as ₹0.
6. The customer screen says nothing extra for non-network refresh failures (cached data is still right);
   only "No internet" is shown, honestly.

**Deviations / changes outside the owned paths**

- `ui/CableApp.kt` (T-008/T-063 shell): `SearchRoute` now wires `SearchScreen`; new `CustomerRoute` and
  `CollectRoute` (placeholder) destinations; two composable slots with defaults; Search tab highlighted on
  its sub-screens and re-tap returns to its first screen. `ui/navigation/TopLevelDestination.kt`: the
  `CollectRoute` class only.
- `CableAppNavigationTest`: passes stand-ins for the two slots (the real screens need Hilt).
- `packages/i18n/glossary.md`: one new table. Regenerated `strings_generated.xml` (en/hi) and
  `apps/web/messages/{en,hi}.json`. `apps/android/README.md`: a "Search home and customer screen" section.
- Tests live in `app/src/test/.../feature/search` and `.../feature/customer` (beside the owned main paths).

**Follow-ups (no task files created)**

- **On a real phone / emulator:** the < 100 ms acceptance on a low-end profile; the number pad really
  covering half the screen on 360 × 640 dp phones (on very short screens, < ~560 dp, the result list gets
  little room and the keys shrink; checked in tests at 360 × 800 dp only); the phone's keyboard opening
  by itself on ABC and the list staying above it (`imePadding`); Hindi text widths (Robolectric measures
  Devanagari narrow); the read-out in real TTS; the dialer opening.
- The search rows do not show "including payments saved on phone" (`CustomerRow` has no slot for it); the
  customer screen does. Add a small clock to `CustomerRow` if field tests ask for it.
- Hindi review (H-03): `mobile_search` `_review` (20 keys) and the new glossary rows.

**Verification** (JDK 21, Android SDK, Node v24.21.0, pnpm 12.11.2, Postgres 17; no emulator)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`: BUILD
  SUCCESSFUL. App JVM tests 150, 0 failures (24 new); designsystem 31; detekt-rules pass; lint 0 errors
  (2 existing warnings). New tests:
  - `SearchViewModelTest` (10, `StandardTestDispatcher`, no real time): 4 quick digits → one search after
    exactly the 50 ms pause; slow typing searches per digit, newest wins; backspace / long-press clear /
    20-digit limit / leading 0 kept; clearing is immediate and never searches blank; "not found" only after
    the answer; ABC → 200 ms name search, 123 keeps the digits; state survives process death; banner from
    the sync status + tap asks for sync; banner wording/colour rules; row amount (due / credit / after phone
    payments).
  - `CustomerViewModelTest` (7, Robolectric for `VoiceLines`): cached copy at once + one refresh; read-out
    "Ramesh Kumar, चार सौ पचास रुपये बाकी" / "… four hundred fifty rupees due" with no ₹/digits; office answer
    updates screen and read-out; offline keeps the copy + NoInternet; phone payments taken off with label and
    extra as credit; loading → not found only after the office also fails; refresh again.
  - `SearchToCustomerTest` (5, Compose UI on Robolectric, Hindi, 360 × 800 dp, real `CableApp` NavHost +
    real ViewModels + in-memory Room roster from the contract fixtures + MockWebServer): type 1045 on the pad
    → Ramesh row (Shiv Nagar, ₹900 बाकी) → customer screen (name, code, area, "2 कनेक्शन", ₹900 बाकी, call
    button dials `tel:9876543210`, read-out spoken, `GET /customers/{id}` requested, Search tab selected) →
    Collect → placeholder; Sunita (advance ₹50 एडवांस, "₹0 कुछ बाकी नहीं", no call button), Back and the Search
    tab return home with "1046" still typed; ABC name search "sunita" then 123; no results; banner "इंटरनेट
    नहीं है · 12 मिनट पहले अपडेट हुआ" (tap asks for sync) and "फ़ोन में 3 पेमेंट" (tap opens Waiting); every
    tappable node on both screens ≥ 56 dp (non-vacuous: it failed on Robolectric's default 320 × 470 dp
    screen where the pad keys shrink to 21 dp).
  - `SearchPerformanceTest` (2, report-only with a loose 1 s bound on the median): 7,616 customers,
    4 digits "4521": repository query median 10 ms (max 13–25 ms); key press → results in the ViewModel
    median 9–11 ms (max 23–34 ms) after the 50 ms debounce (debounce on Robolectric's clock). JVM SQLite on
    a desktop CPU, **not** a low-end phone.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate`
  (no diff), `tokens:build --check`, `icons:build --check`, `i18n:check`, `i18n:build --check`,
  `openapi:build --check`, `node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-13T13:38:58.503Z claimed by agent-t065
- 2026-10-13T14:08:13.826Z completed on task/T-065-android-number-pad-search-home-and-custo
