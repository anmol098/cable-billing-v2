---
id: T-005
title: Next.js web app scaffold
phase: 0
area: web
status: done
owner: agent-t005
claimed_at: 2026-10-13T05:36:59.977Z
branch: task/T-005-next-js-web-app-scaffold
depends_on: [T-001, T-002, T-004]
review: self
claimable_by: agent
size: M
paths: [apps/web/**]
---

# T-005 — Next.js web app scaffold

**Phase** 0 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-001, T-002, T-004

## Goal

A deployable Next.js (latest stable, App Router) app wired to tokens, fonts and i18n.

## Scope

- Next.js + React + TypeScript strict; Tailwind CSS v4 via `@tailwindcss/postcss`, importing `@cb/ui/theme.css` (no other colour sources).
- Fonts: Inter + Noto Sans Devanagari via `next/font` (self-hosted), tabular numerals utility.
- `next-intl` with `en` (default for web) and `hi`; locale stored in a cookie; no locale in URL.
- Route groups created as empty placeholders: `(marketing)`, `(auth)`, `(operator)`, `admin`, `r/[token]`, `api/mobile/v1`, `api/cron`, `api/webhooks`.
- `/api/health` (returns version + DB ping placeholder).
- Env validation module (`src/env.ts`, Zod) – server/client split, fails fast at boot.
- Sentry SDK wired but disabled when DSN is absent.
- Security headers (CSP report-only to start, HSTS, frame-ancestors none).

## Out of scope

- Real pages (later tasks).
- Component library (T-006/T-007).

## Acceptance criteria

- [x] `pnpm --filter web build` succeeds without any env except defaults.
- [x] A test page renders Hindi text in Noto Sans Devanagari and amounts in tabular figures.

## Tests required

- Vitest + Testing Library set up with one component test.
- Playwright installed with one smoke test against `next start` (health + home).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/**`

## References

PLAN §4, PLAN §5, PLAN §6.3, E-06, E-08 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`apps/web`, package `@cb/web`; `pnpm --filter web …` works)

- Next.js **16.4.0** (App Router, Turbopack for dev and build), React **19.3** (catalog), TypeScript 7 strict
  (`tsconfig.json` extends `@cb/config/tsconfig.next.json`, alias `@/*` → `src/*`). `next.config.ts`:
  `transpilePackages: ["@cb/i18n", "@cb/ui"]`, `turbopack.root` / `outputFileTracingRoot` = workspace root,
  `poweredByHeader: false`, `agentRules: false`, security headers, next-intl plugin, `withSentryConfig`.
- Layout: `src/app/layout.tsx` (root: `<html lang={locale}>`, `NextIntlClientProvider`, body
  `bg-bg font-sans font-regular text-base text-text`), `src/app/globals.css` (the only stylesheet:
  `@import "@cb/ui/theme.css"` + `@source` for `packages/ui/src`), `src/app/fonts.ts`.
- Routes: `(marketing)/page.tsx` = placeholder home `/` (T-087 replaces it), `dev/type` = font/number check
  page (404 when `VERCEL_ENV=production`), `api/health`. Empty placeholders (`.gitkeep`): `(auth)`, `(operator)`,
  `admin`, `r/[token]`, `api/mobile/v1`, `api/cron`, `api/webhooks`.
- `src/env.ts`, `src/i18n/*`, `src/lib/{health,security-headers,sentry}.ts`, `src/instrumentation.ts`,
  `src/instrumentation-client.ts`, `src/components/locale-switch.tsx`, `src/test/intl.tsx`.
- i18n namespace `scaffold` (`packages/i18n/messages/{en,hi}/scaffold.json`, Hindi in `_review`), regenerated
  `apps/web/messages/*.json`.

**Interfaces for later tasks**

- **Env (T-011 owns `src/env.ts` next):** `import { serverEnv, clientEnv } from "@/env"`. Add server vars to
  `serverSchema`; add client vars to `clientSchema` *and* to the literal `clientSource` object (Next only inlines
  `process.env.NEXT_PUBLIC_X` written out literally). Wrap optional vars in the local `optional()` helper (empty
  string = unset). `parseEnv(schema, source, label)` throws one `EnvError` naming every bad variable (never the
  value). Validation runs when `next.config.ts` loads (build, start, dev) and again in `instrumentation.ts`;
  verified: `SENTRY_DSN=not-a-url` stops `next build` and `next start`. In the browser `serverEnv` throws on any
  read. Every variable is optional today; required ones (e.g. `DATABASE_URL`) must keep `next build` working
  without env (validate lazily or give CI a dummy) — T-011 decides. Current vars: `NODE_ENV`, `VERCEL_ENV`,
  `VERCEL_GIT_COMMIT_SHA`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_VERCEL_ENV`;
  build-time only (read in `next.config.ts`): `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (source-map
  upload only when the token is set). Add any new build-affecting var to `apps/web/turbo.json` `build.env`
  (turbo runs in strict env mode).
- **i18n:** locale = cookie `NEXT_LOCALE` (`LOCALE_COOKIE` in `src/i18n/config.ts`), default `en`
  (`WEB_DEFAULT_LOCALE`), never in the URL, no middleware/proxy needed. `src/i18n/request.ts` loads
  `messages/<locale>.json` and sets `timeZone: "Asia/Kolkata"`. Server components: `useTranslations("ns")` /
  `await getTranslations("ns")`; another locale explicitly: `getTranslations({ locale: "hi", namespace })`.
  Client components get all messages from the root provider. **Keys are type-checked** (`src/i18n/next-intl.d.ts`
  augments next-intl `AppConfig` with the generated `en.json`), so a missing key fails `pnpm typecheck` — run
  `pnpm --filter @cb/i18n i18n:build` after adding keys. Switch language with the `setLocale` server action
  (`src/i18n/actions.ts`): `<form action={setLocale}><button name="locale" value="hi">`. `LocaleSwitch`
  (`src/components/locale-switch.tsx`) is a scaffold; T-007's `LanguageSwitch` should replace its markup and
  keep `setLocale`. Component tests: `renderWithIntl(ui, locale?)` from `@/test/intl` uses the real messages.
- **Styling (T-006/T-007):** token utilities only (see T-002 notes); no `max-w-*`/container sizes are used since
  tokens define none. Tailwind scans `apps/web` and `packages/ui/src` (the `@source` line). Fonts: the
  `@font-face` rules are registered under the exact token family names (`Inter`, `Noto Sans Devanagari`), so
  `font-sans` / `font-numeric` work with no class from next/font. Inter latin is preloaded; Inter latin-ext (has
  `₹`) and Devanagari load on demand via `unicode-range`. `font-numeric` gives tabular figures (verified).
- **Adding a route:** create `src/app/<segment>/page.tsx` (or `route.ts` for APIs) inside the group the task
  owns; for `.gitkeep` placeholders, add your files and delete the `.gitkeep`. Route handlers touching the DB:
  `export const runtime = "nodejs"` (E-06). T-029 owns `(operator)/layout.tsx`.
- **Health (T-020/T-096):** `getHealth({ commit, pingDb })` in `src/lib/health.ts`; replace the default `pingDb`
  (returns `"not_configured"`) with a real `select 1`; `"error"` makes the route return 503 `degraded`.
- **Sentry (E-08):** `Sentry.init` in `instrumentation.ts` (server/edge) and `instrumentation-client.ts`,
  `enabled` only with a DSN; `onRequestError` and `onRouterTransitionStart` are exported. Shared options in
  `src/lib/sentry.ts` collect no user info, cookies, bodies, query strings, DB query data or frame variables
  (customer PII). Sentry v11 moved `withSentryConfig` to `@sentry/nextjs/config` and dropped `sendDefaultPii`.
- **Security headers:** `securityHeaders({ isDev, sentryDsn })` in `src/lib/security-headers.ts`, applied to
  `/:path*`. Report-only CSP (`default-src 'self'`, scripts `'self' 'unsafe-inline'`, styles inline allowed,
  `connect-src` + `report-uri` derived from the Sentry DSN); enforced `Content-Security-Policy: frame-ancestors
  'none'` + `X-Frame-Options: DENY` (frame-ancestors is ignored in report-only); HSTS 2 years with
  `includeSubDomains`, no `preload` until the domain is decided (D-21); nosniff, referrer policy, permissions
  policy (camera/mic/geolocation off). Anything needing third-party origins (Turnstile T-027, Razorpay T-085)
  must add them here.
- **Scripts:** `dev`, `build`, `start`, `typecheck` (`next typegen && tsc --noEmit`, so it works before a
  build), `test` (Vitest, jsdom, `src/**/*.test.{ts,tsx}`), `test:e2e` (Playwright, separate so `pnpm test` stays
  fast). Turbo runs build/typecheck/test for `@cb/web`; lint is the root Biome run (no `next lint` in Next 16).
- **E2E (T-088 owns `e2e/**` + `playwright.config.ts` next; T-010 CI):** run `pnpm --filter web build` then
  `pnpm --filter web test:e2e`; the config starts `next start` on port 3100 (`E2E_PORT`), or tests
  `E2E_BASE_URL` (preview URL) without a local server. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` overrides the
  browser binary (needed where only an older Chromium is pre-installed); CI should `playwright install chromium`.

**Decisions**

- `next/font/local` with Fontsource's npm woff2 files (OFL) instead of `next/font/google`: offline builds, no
  Google fetch, no committed binaries. `declarations: [{ prop: "font-family", value: "Inter" }]` keeps the token
  stack the single source of font names (checked in the built CSS). `adjustFontFallback: false` (the generated
  fallback face would not be in the token stack anyway).
- Zod runs `jitless` in the browser (set in `src/env.ts`): its JIT probes `new Function()`, which the CSP
  without `'unsafe-eval'` reports. The e2e suite asserts pages raise no CSP reports.
- Locale switch reloads via a server action + cookie (no client JS state, no locale prefix).
- `pnpm-workspace.yaml`: catalog entries `@tailwindcss/postcss`, and `react`, `react-dom`, `@types/react`,
  `@types/react-dom` ^19.3.0 (same lines as T-003's PR, so a rebase just dedupes). `allowBuilds`
  `@parcel/watcher: false`, `@swc/core: false` (pulled in by next-intl; prebuilt binaries come from optional
  platform packages). `@sentry/nextjs` is `^11.6.0` because 11.7.0 was < 1 day old.

**Deviations / shared files touched**

- `biome.json` (T-001, done): `css.parser.tailwindDirectives: true` so Biome parses `@source`.
- `CLAUDE.md`: two command lines (web dev, e2e).
- Placeholder route groups are `.gitkeep` files (git can't hold empty folders; a `page.tsx` would create routes
  other tasks own).
- No `middleware.ts`: not needed for cookie locales. Note for **T-026**: Next 16 renamed middleware to
  `src/proxy.ts` (`middleware.ts` is deprecated); its owned path should follow.
- No favicon/app icon yet (brand undecided, H-02); `/favicon.ico` 404s.

**Verification** (Node v24.21.0, pnpm 12.11.2, no app env set, `TURBO_FORCE=1`)

- `pnpm install --frozen-lockfile`: ok. `pnpm lint`: Biome clean. `pnpm typecheck` 9/9, `pnpm test` 9/9
  (web: 5 files, 20 tests: LocaleSwitch component, env, health, security headers, locale config), `pnpm build`
  9/9 (`pnpm --filter web build` with no env: ok).
- `pnpm --filter web test:e2e` (Playwright 1.64 with the pre-installed Chromium via
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`): 5 passed — health JSON; security headers; home in English → click
  हिंदी → `lang="hi"`, Hindi heading, `NEXT_LOCALE=hi` cookie, URL unchanged, survives reload; `/dev/type`: the
  `Noto Sans Devanagari` and `Inter` faces are loaded, Hindi list's computed family starts with the token stack,
  `₹1,11,111` and `₹8,88,888` render at equal width with `tnum` and at different widths with `tnum` off; no
  CSP reports on `/` and `/dev/type`.
- `next dev`: `/`, `/dev/type`, `/api/health` return 200. Probes: an unknown i18n key fails `tsc`;
  `SENTRY_DSN=not-a-url` / `NEXT_PUBLIC_SENTRY_DSN=nope` fail `next build` and `next start` with `EnvError`.
- `pnpm tokens:build --check`, `pnpm --filter @cb/i18n i18n:build --check`, `pnpm i18n:check`,
  `node scripts/tasks.mjs check --local`: all OK.

## Board log

- 2026-10-13T05:36:59.978Z claimed by agent-t005
- 2026-10-13T05:51:25.685Z completed on task/T-005-next-js-web-app-scaffold
