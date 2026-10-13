---
id: T-024
title: Domain foundations: money, periods, business dates
phase: 1
area: domain
status: done
owner: agent-t024
claimed_at: 2026-10-13T10:25:36.447Z
branch: task/T-024-domain-foundations-money-periods-busines
depends_on: [T-001]
review: self
claimable_by: agent
size: S
paths: [packages/domain/src/money/**, packages/domain/src/time/**, packages/domain/src/result.ts, packages/domain/src/index.ts]
---

# T-024 — Domain foundations: money, periods, business dates

**Phase** 1 · **Area** domain · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-001

## Goal

Pure helpers everyone uses for money and time, so nobody re-invents them.

## Scope

- Money: paise as `bigint`-safe integers (use `number` with safe-integer guard or branded type – document choice), `rupeesToPaise` (whole rupees only, D-17), `formatINR` (Indian grouping, en/hi), parse from user input.
- Time: IST business date from an instant, `periodOf(date)` (1st of month), `nextPeriod`, `periodLabel` (en/hi month names), billing day helpers.
- `Result<T, E>` type + error code union base.

## Acceptance criteria

- [x] No floating-point arithmetic on money anywhere in the package. (Enforced by `src/money/no-float.test.ts`.)

## Tests required

- Unit + fast-check property tests (round-trips, grouping for 0…10^12, IST boundary at 18:30 UTC).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/domain/src/money/**`
- `packages/domain/src/time/**`
- `packages/domain/src/result.ts`
- `packages/domain/src/index.ts`

## References

PLAN §7.1, D-17, PRD §12 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/domain/src/{money,time}/**`, `src/result.ts`; everything is exported from `@cb/domain`)

*Money* (`money/paise.ts`, `format.ts`, `parse.ts`)

- `type Paise` = a **branded `number` that is always a safe integer** (sign allowed: ledger entries and
  balances are signed). Constructors: `paise(n)` (throws `RangeError` on fractions/NaN/unsafe),
  `toPaise(number | bigint | string)` (for DB `bigint` columns: `pg` returns strings, Drizzle may return
  bigint/number), `rupeesToPaise(wholeRupees)` (D-17: non-negative whole rupees ≤ `MAX_INPUT_RUPEES`),
  `isPaise(x)`. Out: `paiseToBigInt(p)`, `splitRupees(p)` → `{ rupees, paise }`, `isWholeRupees(p)`.
  Constants: `PAISE_PER_RUPEE`, `ZERO_PAISE`, `MAX_RUPEE_DIGITS = 13`, `MAX_INPUT_RUPEES`.
- Checked arithmetic (every result re-validated, so overflow throws instead of rounding): `addPaise`,
  `subtractPaise`, `sumPaise(iterable)`, `multiplyPaise(p, count)`, `negatePaise`, `absPaise`, `minPaise`,
  `maxPaise`, `comparePaise` (sort). Plain `<`, `>`, `===` are fine on `Paise`.
- `formatINR(amount, { locale?: "en" | "hi", numerals?: "latin" | "devanagari", sign?: "minus" | "absolute" })`
  → `"₹1,23,456"`, `"₹12.50"` (paise only when not whole), `"-₹500"` (default) or `"₹500"` (`absolute`).
  Accepts `Paise`, a safe-integer `number` or a `bigint` (SQL totals).
- `formatRupees(amount)` → `{ text, negative }`: **same contract as `@cb/ui` `formatRupees`**.
  `groupIndian(digits)` and `paiseToRupeeDigits(p | null)`: same as `@cb/ui`. `toAsciiDigits` /
  `toDevanagariDigits` (Hindi keyboard input, search).
- `parseRupeesInput(text)` →
  `Result<{ paise: Paise | null; digits: string }, "decimal" | "negative" | "invalid" | "too-large">`: same
  rules as `@cb/ui`'s (₹, commas, spaces and Devanagari digits accepted; decimals refused), in the `Result`
  shape.

*Time* (`time/business-date.ts`, `period.ts`, `labels.ts`)

- `type BusinessDate` = branded `"YYYY-MM-DD"` (what Postgres `date` / Drizzle `mode: "string"` hold), years
  1000–9999. `businessDateOf(instant: Date | epochMs)` (IST; **the day changes at 18:30 UTC**),
  `istStartOfDay(d)` → `Date`, `istDayRange(d)` → `{ start, end }` half-open (for `recorded_at` queries),
  `addDays`, `compareBusinessDates`, `dateParts`, `businessDateFromParts`, `daysInMonth`,
  `isBusinessDate`, `parseBusinessDate` (→ `Result<_, DomainError<"VALIDATION">>`), `businessDate(s)`
  (throwing). `IST_TIME_ZONE`, `IST_OFFSET_MINUTES = 330`.
- `type Period` = branded `BusinessDate` that is a 1st (`"2026-10-01"`, matches the DB `CHECK`), so it passes
  wherever a `BusinessDate` is expected. `periodOf(date)`, `periodOfInstant(now)` (the current period),
  `nextPeriod`, `previousPeriod`, `addPeriods(p, n)`, `monthsBetween`, `periodsBetween(from, to, max = 1200)`
  (inclusive, oldest first: "Missed bill runs", D-25), `periodEnd(p)` (last day), `periodContains`,
  `comparePeriods`, `isPeriod`, `parsePeriod` (accepts `YYYY-MM-01` and `YYYY-MM`), `period(s)` (throwing),
  `periodFromYearMonth(y, m)`.
- Billing day: `BILLING_DAY_OF_MONTH = 1`, `isBillingDay(date)`. The scheduler (`45 18 * * *` UTC = 00:15 IST)
  does `const today = businessDateOf(now); if (isBillingDay(today)) … periodOf(today)`.
- `yymm(dateOrPeriod)` → `"2610"` for `INV-{YYMM}-…` / `R-{YYMM}-…` (PLAN §7.3).
- `periodLabel(p, locale, style = "long")` → `"October 2026"` / `"अक्टूबर 2026"` (`short`: `"Oct 2026"` /
  `"अक्टू 2026"`); `formatBusinessDate(d, locale, style = "short")` → `"12 Oct 2026"` / `"12 अक्टू 2026"`
  (PLAN §2.2 rule 10); `monthName(m, locale, style)`, `MONTH_NAMES`. `DISPLAY_LOCALES` / `type DisplayLocale`
  (`"en" | "hi"`, the same values as `@cb/i18n` `Locale`).

*Result* (`result.ts`)

- `Result<T, E = DomainError>` = `{ ok: true, value } | { ok: false, error }`; `ok`, `err`, `isOk`, `isErr`,
  `mapResult`, `mapErr`, `andThen`, `unwrapOr`, `unwrap` (throws `ResultError`).
- `BASE_ERROR_CODES` / `BaseErrorCode`: `VALIDATION`, `NOT_FOUND`, `FORBIDDEN`, `UNAUTHENTICATED`, `CONFLICT`,
  `TENANT_READ_ONLY`, `ID_REUSED_WITH_DIFFERENT_DATA`, `INVARIANT_VIOLATION`; `isBaseErrorCode`.
  `DomainError<C extends string = BaseErrorCode>` = `{ code, message?, details? }` (the message is for logs
  only: never shown, never PII); `domainError(code, message?, details?)`. Extend with your own codes:
  `DomainError<BaseErrorCode | "NOTHING_TO_BILL">`.
- Convention: expected failures are returned as `err`; programmer errors (unsafe paise, invalid dates from
  trusted sources) throw `RangeError`.

**Decisions**

- **`number` + safe-integer guard + brand, not `bigint`.** Amounts cross JSON (mobile API, server actions,
  React props), where `bigint` doesn't serialise; Zod, Drizzle and `@cb/ui` all use `number`. 2^53 paise
  (about ₹90 lakh crore) is far above any amount here. The brand stops rupee/paise mix-ups, and the
  checked helpers make overflow loud. Formatting uses `bigint` string maths. DB columns stay `bigint`
  (`*_paise`): T-020+ should read them with Drizzle `bigint({ mode: "number" })` or pass the raw value to
  `toPaise`.
- **Hindi uses Latin digits** (PLAN §11.4; glossary: "Digits stay Latin (0–9) in Hindi too"), so
  `formatINR(x, { locale: "hi" })` gives the English text. That is exactly what `@cb/ui` `Amount` and Android
  `Rupees.format` print today (all three: `₹1,23,456`, and `₹12.50` when not whole rupees).
  `numerals: "devanagari"` is there only for Q-09; nothing uses it.
- **No `Intl`, no tz database.** IST is a fixed +05:30 (no DST since 1945), so business dates are epoch
  arithmetic. Month names are tables, because ICU builds disagree on Hindi abbreviations (`अक्तू॰` vs the
  glossary's `अक्टू`) and Android must match. Tests use `Intl` only as an **oracle** (en-IN grouping and
  `Asia/Kolkata` dates over 2,000 random instants each), skipped if the runtime lacks the data.
- **Nothing reads the clock.** Callers pass `now` (`businessDateOf(new Date())`).

**Deviations / files outside the owned paths**

- Month names (en/hi) are data in `time/labels.ts`, not i18n keys: the task scope puts `periodLabel` in the
  domain, and the server, receipts and exports need them without an i18n runtime. **The Hindi month names
  (long and short) are machine-drafted and need the H-03 review.** They aren't in an i18n `_review` list
  because they aren't i18n keys.
- `pnpm-workspace.yaml`: added `fast-check: ^4.10.2` to the catalog (T-040/41/42 will need it too; write
  `"fast-check": "catalog:"`). `packages/domain/package.json`: `fast-check` devDependency. `pnpm-lock.yaml`.
- New test files next to the owned files: `src/result.test.ts`, `src/money/*.test.ts`, `src/time/*.test.ts`.
  `src/index.ts` keeps `packageName`, so T-001's `index.test.ts` still passes.

**Follow-ups (for whoever touches these next)**

- **`packages/ui/src/lib/money.ts` (`TODO(T-024)`)**: swap to `@cb/domain`. Not done here (outside this
  task's paths). `groupIndian`, `formatRupees`, `paiseToRupeeDigits`, `rupeesToPaise`, `PAISE_PER_RUPEE`,
  `MAX_RUPEE_DIGITS` and the `RupeesInputRejectReason` type re-export one for one. `parseRupeesInput` differs
  only in shape, so keep the UI name with a 3-line adapter:
  `const r = parseRupeesInput(text); return r.ok ? { ok: true, ...r.value } : { ok: false, reason: r.error };`
  `@cb/ui` then needs `"@cb/domain": "workspace:*"` in its dependencies. `rupeesToPaise` also caps input at
  13 digits (`MAX_INPUT_RUPEES`), which the UI already enforces.
- Android: `Rupees.kt` already matches `formatRupees`. When Android needs month labels or business dates,
  mirror `MONTH_NAMES` and use `ZoneOffset.ofHoursMinutes(5, 30)`.
- T-040/T-041/T-042: use `Paise` with the checked helpers, `Period` and `Result`. T-051: Zod
  `z.number().int().refine(Number.isSafeInteger).transform(paise)` for money; `isBusinessDate` / `isPeriod`
  for dates. T-043/T-044: `businessDateOf(now)`, `isBillingDay`, and `periodsBetween` for catch-up.

**Tests / checks** (`packages/domain`: 9 files, 177 tests)

- `money/paise.test.ts`: constructors and guards; DB `toPaise` (number/bigint/string; refuses `"12.50"`,
  `"1e3"`, > 2^53); round-trips through bigint and string; `rupeesToPaise` exact for all 0…MAX_INPUT_RUPEES;
  checked arithmetic against bigint (properties); overflow throws.
- `money/format.test.ts`: `groupIndian` table plus a property over **0…10^12** (shape regex, digits kept,
  and agreement with `Intl` en-IN); `formatINR` table (₹0, ₹99, ₹1,00,000, ₹1,23,456, ₹12.50, negatives);
  en = hi; Devanagari option; bigint totals; **format → parse round-trip** for 0…10^12 rupees (Latin and
  Devanagari digits).
- `money/parse.test.ts`: accepts ₹, commas, spaces, Devanagari digits and leading zeros; refuses decimals
  (`12.00` too), negatives, `1e3`, `Infinity`, `0x10` and 14 digits; property: never throws, and accepted
  values are whole-rupee paise.
- `money/no-float.test.ts` (**acceptance**): scans every non-test `.ts` in `packages/domain/src` (comments
  stripped) for `parseFloat`, `toFixed`/`toPrecision`, `Math.round/floor/ceil/trunc`, fractional literals,
  `/ 100` or `/ PAISE_PER_RUPEE` on numbers, `* 0.01`, and (in `money/`) any number division. Each rule is
  proven to fire on a sample and not on the bigint forms. Also checked by injecting
  `Math.round(a / n) + a / 100 + parseFloat("1.5")` into `paise.ts`: 5 rules failed; reverted.
- `time/business-date.test.ts`: **IST boundary** table (`2026-10-31T18:29:59.999Z` → 31 Oct,
  `18:30:00.000Z` → 1 Nov, year end, leap day, the scheduler's 18:45 UTC); properties: the day starts exactly
  at 18:30 UTC (start − 1 ms is the previous date), every instant lies in its `istDayRange`, and agreement
  with the `Asia/Kolkata` tz database; validation (30 Feb, month 13, wrong formats); `addDays` invertible.
- `time/period.test.ts`: `periodOf` (and instants across 18:30 UTC), next/previous/addPeriods across years,
  properties (next = periodEnd + 1 day, inverses, `monthsBetween`), `periodEnd` incl. leap February,
  `parsePeriod`, `periodsBetween` (and its bound), `isBillingDay`, `yymm`.
- `time/labels.test.ts`: `October 2026` / `अक्टूबर 2026`, `12 Oct 2026` / `12 अक्टू 2026`, 12 distinct
  names per locale and style, Hindi names in Devanagari only.
- `result.test.ts`: narrowing (also at type level), combinators, `unwrap` throws, base codes.

**Verification** (Node v24.21.0, pnpm 12.11.2): `pnpm install`, `pnpm lint`, `pnpm typecheck` (9/9),
`pnpm test` (9/9; domain 177 tests), `pnpm build` (9/9), `pnpm generate` (no diff),
`node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-13T10:25:36.454Z claimed by agent-t024
- 2026-10-13T10:35:32.393Z completed on task/T-024-domain-foundations-money-periods-busines
