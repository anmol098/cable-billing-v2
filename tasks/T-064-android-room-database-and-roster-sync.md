---
id: T-064
title: Android: Room database and roster sync
phase: 3
area: android
status: done
owner: agent-t064
claimed_at: 2026-10-13T12:48:27.295Z
branch: task/T-064-android-room-database-and-roster-sync
depends_on: [T-063]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/data/db/**, apps/android/app/src/main/java/com/cablebilling/lineman/data/sync/RosterSync*.kt, apps/android/app/schemas/**]
---

# T-064 — Android: Room database and roster sync

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-063

## Goal

The phone always has the roster, even offline.

## Scope

- Room entities from PLAN §11.5 (payments queue table defined here but used by T-066).
- Roster sync worker: initial + delta, periodic 30 min, on app open, after push; `sync_meta` last-updated.
- Repository flows for search and customer detail with projected balance (server − unsynced local).

## Acceptance criteria

- [x] Airplane mode: search still works with last data and shows 'Updated X min ago'. (Data side: `RosterRepository.search` + `syncStatus().minutesAgo`, tested in `RosterSyncTest`; the banner words and screen are T-065's.)

## Tests required

- DAO tests, sync worker tests with MockWebServer, Room migration test baseline.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/data/db/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/sync/RosterSync*.kt`
- `apps/android/app/schemas/**`

## References

PLAN §10.3, PLAN §11.5 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`apps/android/app/src/main/java/com/cablebilling/lineman/…`; overview in `apps/android/README.md`)

- `data/db/CableDatabase` (Room, file `cable.db`, **version 1**, schema exported to
  `app/schemas/com.cablebilling.lineman.data.db.CableDatabase/1.json`). Tables (PLAN §11.5):
  `customers`, `customer_vcs`, `open_bills` (roster cache, server data only), `payments` (local queue,
  `PaymentEntity` + `PaymentState`), `receipt_actions_outbox` (`ReceiptActionOutboxEntity` +
  `OutboxState`), `collection_day` (`CollectionDayEntity`), `sync_meta` (`SyncMetaEntity`, one row per
  stream; the roster is `SyncStreams.ROSTER`). `CableMigrations.ALL` (empty). `DatabaseModule` (Hilt:
  database, every DAO, `TimeSource`).
- DAOs: `CustomerDao` (reads: `searchByDigits`, `searchByName`, `observeDetail`, …), `RosterWriteDao`
  (writes, used only by `RosterStore`), `PaymentDao`, `SyncMetaDao`, `ReceiptActionDao`,
  `CollectionDayDao`.
- `data/db/RosterStore`: every roster write, one transaction each (`applyPage`, `storeDetail`,
  `removeCustomer`, `claimFor`, `clearCursor`, `recordAttempt`) + `syncing: StateFlow<Boolean>`.
- `data/db/RosterRepository` (read side, for screens): `search(query, limit = 50): Flow<List<CustomerSummary>>`,
  `customer(id): Flow<CustomerDetail?>`, `refreshCustomer(id): ApiResult<CustomerDetailResponse>`,
  `syncStatus(tickMillis = 30 s): Flow<RosterSyncStatus>`. `ProjectedBalance` (`duePaise`, `creditPaise`,
  `balancePaise`, `pendingPaise`, `pendingCount`, `includesPhonePayments`). `SearchText` (normalisation).
- `data/sync/RosterSync` (engine, `run(): RosterSyncResult` = `Synced | NotSignedIn | Failed(ApiFailure)`,
  `markStale()`), `RosterSyncWorker` (`@HiltWorker`), `RosterSyncScheduler` (`start()`, `requestNow()`,
  `schedulePeriodic()`; unique works `roster-sync-now` / `roster-sync-periodic`, tag `roster-sync`).

**How later tasks use it**

- **T-065 (search + customer):** inject `RosterRepository`. `search(text)` decides by itself: digits only
  → number-pad search over code, phones (any part, digits only) and VC numbers; any letter → name/code
  search (case-insensitive, NFC, spaces collapsed, `%`/`_` literal). Ranking: exact code, a whole
  phone/VC/code equal to the digits, a number starting with them, the rest; then name. Show
  `balance.duePaise` large and red, `balance.creditPaise` separately, and the label "including payments
  saved on phone" when `balance.includesPhonePayments`. Customer screen: `customer(id)` (connections in
  server order, cached open bills, projected balance), and call `refreshCustomer(id)` when it opens
  (online: stores the row + open bills, the Flow updates; offline: `ApiFailure.Offline`, cached data stays;
  CUSTOMER_NOT_FOUND: the customer leaves the roster and the Flow emits null). Sync banner:
  `syncStatus()` → `minutesAgo` (null = never synced), `syncing`, `lastFailure`, `savedOnPhoneCount`
  ("3 payments on phone"). The words ("Updated X min ago") belong to `mobile_search` (T-065).
  Measured here: a 4-digit search over 7,616 customers takes ~10 ms on Robolectric's SQLite (JVM, not a phone).
- **T-066 (payments):** `PaymentDao.insert` (ABORT on duplicate id / provisional ref; no delete and no
  REPLACE exist on purpose), `update`, `get`, `observe`, `oldestSavedOnPhone(50)`, `observeNotSent()`,
  `observeSavedOnPhoneCount()`, `observeDay(collectorId, date)`. Store `recorded_at` as epoch ms and send
  `Instant.ofEpochMilli(it).toString()`; `business_date` = India date of `recorded_at`. When a push posts
  something call `RosterSyncScheduler.requestNow()`. Store the server's `posted_at` (epoch ms) on
  SENT_TO_OFFICE rows: the projection keeps subtracting a posted payment until the roster row's
  `updated_at` passes its `posted_at`, so the due does not jump back up between push and roster sync.
  A new state (e.g. a held queue) needs no migration (TEXT), but check `RosterQueries.PENDING_FOR_CUSTOMER`.
- **T-069:** `ReceiptActionDao` + `receipt_actions_outbox` (honest actions only). **T-070:**
  `CollectionDayDao` + `collection_day` (server totals, `handover_json`, `queued_handover_json` for an
  offline handover), local totals from `PaymentDao.observeDay`.
- **Schema changes (T-066, T-072 …):** bump `CableDatabase.VERSION`, add `Migration(n-1, n)` to
  `CableMigrations.ALL`, build, commit `schemas/…/<n>.json`, add its `identityHash` to
  `CableDatabaseMigrationTest` (the test fails if an existing version's JSON changes, if a version has no
  migration step, or if the payment saved on any older version is lost).

**Decisions**

1. **Instants as epoch-ms `Long`** (`*_at` columns), parsed from / formatted to ISO-8601 `Z` at the network
   edge; dates and bill months stay `YYYY-MM-DD` text as on the wire; money `*_paise` `Long`. Numeric
   instants make the "older copy" guard and the projection rule plain integer comparisons.
2. **Search without FTS:** one pre-computed `search_digits` column (space-separated digit tokens of code,
   phones and VCs, so a match never spans two numbers) and one `search_name` column, scanned with
   `LIKE '%…%'`. FTS tokenizers do not match inside numbers ("any part of the phone"), and the roster is
   small. Indexes on `code`, `name`, `phone` and `customer_vcs.vc_number` for exact lookups.
3. **Projected balance** = server balance − (payments `SAVED_ON_PHONE` + payments `SENT_TO_OFFICE` whose
   `posted_at` is after the cached row's `updated_at`). Rejected payments (`NEEDS_OFFICE_HELP`) are not
   subtracted. Credit = server credit + phone money beyond the due.
4. **Full sync** commits page by page (searchable while the first sync runs) but stores the cursor and
   drops customers it did not receive only with the last page; an interrupted full sync keeps the old rows
   and no cursor and restarts next time. **Delta** pages store the cursor in the same transaction. A copy
   older than the stored `updated_at` is ignored; a changed customer's cached open bills are dropped.
   Inactive customers in a page or in a detail answer are treated as tombstones.
5. **Tenant safety on a shared phone:** `sync_meta.scope` = operator id. `RosterStore.claimFor` wipes the
   roster (never payments) before writing for another operator, and the repository returns nothing while
   the stored roster belongs to another operator.
6. **Triggers:** `RosterSyncScheduler.start()` (from `CableApplication.onCreate`) watches the session:
   sign-in (or the stored session at start) → periodic work + a pull now; `ProcessLifecycleOwner` start
   (app to foreground) while signed in → a pull now. All work needs `NetworkType.CONNECTED`, exponential
   backoff from 30 s; WorkManager is not touched until someone is signed in. `requestNow()` uses KEEP plus
   `RosterSync.markStale()`, so a pull requested while one runs makes it pull once more (max 3 rounds).
   Worker: retry on `Offline`/429/5xx (5 runs), failure otherwise; success → `AppConfigRepository.refresh()`.
7. "Updated X min ago" uses the phone clock at the end of the last complete sync (`last_success_at`);
   `last_server_time` is stored too for clock checks later.

**Deviations / changes outside the owned paths**

- `CableApplication.kt` (T-008): one injected field + one line `rosterSync.start()`.
- `libs.versions.toml`: `androidx-lifecycle-process` (already on the classpath transitively, now explicit),
  `androidx-work-testing`. `app/build.gradle.kts`: three dependency lines and an appended block that adds
  `schemas/` to the **debug** build type's assets (Robolectric sees the tested variant's assets only, and
  the Room plugin adds schemas to androidTest only; release builds never carry them).
- `apps/android/README.md`: layout lines and an "Offline roster" section.
- No user-facing strings were added (no screen in this task); T-065 owns the banner words.

**Follow-ups (no task files created)**

- T-066 / T-072: check `PRAGMA synchronous` on real devices. Room uses WAL; AOSP's WAL sync mode is FULL
  but OEMs may set NORMAL (a power cut could then lose the last committed payment). If needed, open the
  database with `JournalMode.TRUNCATE` or set the pragma on the write connection.
- T-060 (server): the app relies on `RosterCustomer.updated_at` moving whenever the balance changes
  (a posted payment), as the contract says.
- Test note: in mockwebserver3 5.5, `onRequestStart(SocketEffect.ShutdownConnection)` answered an empty
  200 here (a `Malformed`, not `Offline`); these tests use `onResponseStart(SocketEffect.CloseSocket())`.

**Verification** (JDK 21, Android SDK, Node v24.21.0, pnpm 12.11.2; no emulator)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`: BUILD
  SUCCESSFUL; 126 app JVM tests, 0 failures. New: `RosterDaoTest` (13: digit search over code / phone part /
  VC, no match across numbers, ranking, name search incl. Hindi and literal `%`/`_`, projection rule incl.
  posted-after-`updated_at` and rejected payments, detail relations, Flow update on payment insert, payment
  id / provisional-ref uniqueness, queue reads, wire-value storage, 7,616-customer search), `RosterSyncTest`
  (14, MockWebServer with the contract fixtures: first full sync, delta with cursor + tombstone keeping
  payments, two-page full sync dropping unseen customers, CURSOR_INVALID → full resync keeping payments,
  **airplane mode: search still answers and `syncStatus()` says 12 min ago with `offline`**, interrupted full
  sync keeps old rows and no cursor, older copy ignored, other operator's roster hidden then replaced with
  payments kept, signed out → no request, `markStale` during a run → one more pull, projected balance,
  detail refresh stores open bills / CUSTOMER_NOT_FOUND drops / offline keeps cache),
  `RosterSyncWorkerTest` (6: success + `/app/config`, retry on offline / 500 / 429 up to 5 runs, failure on
  403, success when signed out, the scheduler's unique one-time + 30-min periodic work with `CONNECTED`, run
  end to end through WorkManager's test driver, `start()` schedules for a signed-in lineman),
  `CableDatabaseMigrationTest` (4: schemas committed, v1 identity hash frozen, every version migrates to the
  current one through `MigrationTestHelper` and keeps a payment, one migration per step).
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate`
  (no diff), `node scripts/tasks.mjs check --local`: pass.
- **Not verified on a device:** search speed on a low-end phone (T-065's acceptance), WorkManager periodic
  runs and the app-open trigger on real Android versions (API 26 and 35+), the WAL sync mode of real devices.

## Board log

- 2026-10-13T12:48:27.295Z claimed by agent-t064
- 2026-10-13T13:25:08.597Z completed on task/T-064-android-room-database-and-roster-sync
