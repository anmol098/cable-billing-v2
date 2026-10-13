---
id: T-087
title: Marketing, pricing and legal pages
phase: 4
area: web
status: done
owner: agent-t087
claimed_at: 2026-10-13T15:27:46.680Z
branch: task/T-087-marketing-pricing-and-legal-pages
depends_on: [T-007]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/(marketing)/**, packages/i18n/messages/*/marketing.json]
---

# T-087 — Marketing, pricing and legal pages

**Phase** 4 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-007

## Goal

Public pages needed for sign-up, Razorpay and the Play Store listing.

## Scope

- Landing (what it does, in plain words), pricing (₹400 + GST/month, unlimited customers, 30-day free trial), privacy policy and terms drafts (clearly marked for legal review), contact.
- Hyper-minimal, bilingual, fast on 3G.

## Acceptance criteria

- [ ] Lighthouse mobile performance ≥ 90.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(marketing)/**`
- `packages/i18n/messages/*/marketing.json`

## Notes

- Legal text must be reviewed by a human before launch.

## References

D-15, D-19, D-21, D-22 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**Acceptance criterion not ticked:** Lighthouse mobile performance measured **86–99** (details under
Verification). Most runs are ≥ 90, but the Hindi pages and pages showing `₹` dip to 86–89. The
causes are app-wide, not in these pages: the Sentry browser SDK (~128 KB gzip on every page) and
up to ~257 KB of fonts. `/login` scores 85 on the same setup. Follow-up **T-087a** has the
numbers and options.

**What exists**

| Where | What |
|---|---|
| `apps/web/src/app/(marketing)/layout.tsx` | Public frame: product name, Price, Sign in / Open app, language switch, footer (Price, Privacy policy, Terms of use, Contact us), skip link. Reads only cookies: no database. |
| `(marketing)/page.tsx` → `_components/home-content.tsx` | `/`: h1 product name, one-line "what it is", "30 days free. Then ₹400 a month + GST.", **Start free trial** (→ `/signup`), 7 feature cards (icon + title + one sentence), 3 numbered start steps, closing call to action. |
| `pricing/page.tsx` → `_components/pricing-content.tsx` | `/pricing`: **₹400** first (amount size), "₹472 a month with 18% GST", what's included (unlimited customers, office web + lineman Android, Hindi/English, first 30 days free), 6 questions with all answers visible (after the trial, not paying → 15 days then view only with collections still working, data never deleted, no customer limit, the GST sum, the app doesn't take money from customers). |
| `privacy/page.tsx`, `terms/page.tsx` → `_components/legal.tsx` | `LegalContent({ doc })` from the typed lists `PRIVACY_SECTIONS` / `TERMS_SECTIONS`. Both start with an amber **"Draft: for legal review / ड्राफ़्ट: कानूनी जाँच के लिए"** note ("A lawyer has not checked it yet, and it is not final", plus "Draft of 13 Oct 2026") and are `noindex`. |
| `contact/page.tsx` → `_components/contact-content.tsx` | `/contact`: `mailto:` from `SUPPORT_EMAIL`; `tel:` + WhatsApp click-to-chat from optional `SUPPORT_PHONE`. When neither is set, says honestly "Contact details will be added here soon." Plus "Forgot your password? Get a new one" (→ `/reset`) and "Linemen: ask your office". |
| `_lib/facts.ts` | `SUBSCRIPTION_PRICE_PAISE` (40 000), `GST_PERCENT` 18, `TRIAL_DAYS` 30, `GRACE_DAYS` 15, `LEGAL_DRAFT_DATE`, `gstOn()` (exact integer paise, throws instead of rounding), `marketingFacts()` → `{ price, gst_amount, total, gst, days, grace }`, `RECEIPT_LINK_DAYS` (= core's `RECEIPT_LINK_TTL_DAYS`). Every number on the pages comes from here. |
| `_components/links.tsx` | `MARKETING_PATHS`, `SIGN_UP_PATH` (`/signup`), `SIGN_IN_PATH` (`LOGIN_PATH`), `RESET_PATH`, `TrialButton`, `SignInLine`, `TEXT_LINK`, `CONTAINER`. |
| `packages/i18n/messages/{en,hi}/marketing.json` | Every word (137 keys); all Hindi listed in `_review`. Glossary: new "Public pages (web)" table. |

**Decisions**

1. **What `/` does for signed-in users:** it still shows the landing page, with no redirect. A session
   cookie only changes the header link from "Sign in" to **"Open app"**. Both go to `/login`, which
   already sends a signed-in user to their own home (`/home` for owner/staff, `/admin` for the
   platform admin; T-026). This needs no database call on public pages, and owners can still read
   the price and legal pages. Routes `/pricing`, `/privacy`, `/terms` and `/contact` don't overlap the
   operator prefixes in `PROTECTED_PREFIXES`.
2. **No client JavaScript of our own:** every file is a server component (a test fails on
   `"use client"` under `(marketing)`). Links are plain `<a>` tags, so nothing is prefetched on slow
   networks. The language switch is T-007's no-JS form. Next.js's runtime still loads.
3. **The marketing text isn't sent to the browser:** next-intl 4's `NextIntlClientProvider` sends
   *every* namespace to the client by default. That would have added ~11 kB (en) / ~22 kB (hi) of
   marketing and legal text to **every operator page**. The root layout now passes
   `clientMessages(messages)`, which drops `SERVER_ONLY_NAMESPACES = ["marketing"]`
   (`src/i18n/client-messages.ts`).
4. **Zod removed from every page's JavaScript** (−33 kB gzip): `instrumentation-client.ts` now reads
   `process.env.NEXT_PUBLIC_SENTRY_DSN` / `NEXT_PUBLIC_VERCEL_ENV` directly instead of importing
   `clientEnv` from `@/env`. The values are still validated on the server at `next build`/`start`
   (next.config imports `@/env`).
5. **Contact details come from the environment, not code:** new `SUPPORT_EMAIL` (**required in
   production**, because Razorpay and the Play listing need a public contact) and optional
   `SUPPORT_PHONE` (`+91` and 10 digits). Both are in the env schema with format tests,
   `.env.example`, `turbo.json` and the runbook (§3 matrix, §4.4 step 6).
6. **Price numbers are duplicated from D-20/D-22** in `_lib/facts.ts` until T-085's config-driven
   plan exists. T-085 should export the amounts and these pages should read them from there.
7. **Legal drafts state only facts from the BRD/PRD/PLAN and the code.** They cover what data is
   stored and why; receipt links (first name + part of the phone, 90 days, revocable); the providers
   (Vercel, Neon, Resend, Razorpay, Cloudflare Turnstile, Sentry, Upstash) and the Singapore
   database; cookies; data not deleted when the subscription ends (retention after closure "not
   decided yet", Q-06); trial, price, grace, view-only and missed months (D-13/D-20/D-22/D-25);
   receipts are not GST tax invoices (BRD constraint); the app opens WhatsApp/SMS and cannot know if
   messages arrived (BR-11/12); records are append-only. The drafts don't include liability,
   governing law, refunds, data-subject rights, a grievance officer, the legal entity or address.
   Those are for the lawyer. The drafts are `noindex` until approved.
8. One primary button per screen: the landing page shows the same "Start free trial" button at the
   top and again after the feature list (same action, long page on a phone). Every other action is
   a secondary button or a text link.
9. New icon `email` (Lucide `mail`) for the contact page, with the generated web data and Android
   drawable.

**Deviations / files outside the owned paths**

- `apps/web/src/app/layout.tsx` (T-005, done) + new `apps/web/src/i18n/client-messages.ts`: decision 3.
- `apps/web/src/instrumentation-client.ts` + one comment in `apps/web/src/env.ts` (T-011/E-08, done): decision 4.
- `apps/web/src/env.ts`, `env.test.ts`, `.env.example`, `turbo.json`, `docs/runbooks/environments.md`: the two new variables (decision 5), following runbook §8.
- `apps/web/e2e/marketing.spec.ts` (T-088's e2e folder, as T-026/T-029 did).
- `packages/design-tokens/icons.json` + generated icons, `packages/i18n/glossary.md`, generated `apps/web/messages/*.json`.
- Left alone: the now-unused `scaffold.home.*` keys (T-005's namespace; `i18n/config.test.ts` still reads `scaffold.home.placeholder`).

**Open questions for the product owner**

- **Legal review is required before launch.** It needs to add the legal entity name and address,
  the grievance contact and DPDP Act 2023 rights, governing law and liability, the refund/cancellation
  policy (Razorpay asks for one), and the data-retention period (Q-06). It should also confirm the
  listed providers and the Singapore location after H-01, and remove the draft note and `noindex`
  when approved (`LEGAL_DRAFT_DATE` in `_lib/facts.ts`).
- Set `SUPPORT_EMAIL` (and optionally `SUPPORT_PHONE`) as part of H-01/H-02. Production builds now
  fail without `SUPPORT_EMAIL`.
- Hindi review (H-03): all of `marketing.json`. Key choices: कीमत (Price), फ़्री ट्रायल, ग्राहक जितने
  चाहें (unlimited customers), सिर्फ़ देख सकते हैं (view only), हमसे बात करें (Contact us).
- Wording claims to confirm: "No card needed to start" (T-027's form asks for none), "UPI Autopay
  or card" for our fee (PLAN §13, T-085 not built yet), and "Bills are made on the 1st; you can check
  them before that".
- The `/signup` link is live but T-027 isn't merged yet. The e2e test checks the link and starts
  requiring `/signup` to answer 200 as soon as the route exists.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `pnpm --filter web test`: 16 files / 169 tests. New `(marketing)/_components/marketing.test.tsx`
  (23) covers:
  - the facts (₹400 + 18% = ₹472; GST throws instead of rounding; 30/15/90 days);
  - the frame (Sign in vs Open app → `/login`; footer links; skip link; switch state in en/hi);
  - each page in en and hi (headings, `/signup` and `/login` hrefs, an icon on every feature card,
    price-first card, FAQ answers with the numbers);
  - both legal drafts showing the draft note in en and hi, with "Draft of 13 Oct 2026" /
    "13 अक्टू 2026 का ड्राफ़्ट";
  - contact with email + phone, email only, and nothing configured, plus mobile formatting;
  - **i18n completeness**: every key the pages build exists, non-empty, in en and hi, and no
    marketing key is unused;
  - no "sent"/"delivered" next to WhatsApp/SMS;
  - no `"use client"` under `(marketing)`; `clientMessages` drops `marketing`.

  `env.test.ts` adds a test for the `SUPPORT_*` formats.
- `pnpm --filter web test:e2e` (scratch DB `cb_e2e_t087` migrated, `E2E_PORT=3287`, pre-installed
  Chromium): **47 passed**, 18 of them new in `e2e/marketing.spec.ts`:
  - all 5 pages × en/hi return 200 with the right `lang`, title and h1, the header sign-in link, and
    no console errors, failed requests or CSP reports (the only exception is the browser's own
    `/favicon.ico` 404 until H-02);
  - no horizontal scroll at 360px on any page in either language;
  - Start free trial → `/signup` and the header Sign in opens the sign-in page;
  - the footer reaches every page;
  - a session cookie shows "Open app" and `/` still renders;
  - the language switch works on `/pricing`;
  - both legal pages carry the draft note and `noindex`;
  - `/contact` shows the honest "not set up" text.
- Screenshots at 360px and 1280px in en and hi, checked by eye.
- **Lighthouse 12.8.2**, mobile preset with simulated throttling (150 ms RTT, 1.6 Mbps, 4× CPU),
  run against `next start` on a shared 4-CPU container. Accessibility 100, SEO 100 (60 on the two
  `noindex` drafts, on purpose), best practices 96 (favicon 404). Performance:

  | Run | Pages |
  |---|---|
  | First run (before the Zod change) | en: `/` 90–98, `/pricing` 88–89, `/privacy` 94, `/terms` 88–91, `/contact` 96–98; hi: 85–95 |
  | After the Zod change, en | `/` 92, `/pricing` 97, `/privacy` 96, `/terms` 88, `/contact` 99 |
  | After the Zod change, hi | `/` 87, `/pricing` 86, `/privacy` 86, `/terms` 87, `/contact` 99 |

  Other metrics: CLS 0 to 0.001; TBT 90–230 ms; observed LCP < 0.2 s, simulated LCP 1.4–3.7 s.
  Transfer per page: 390–480 KiB, of which HTML is 10–14 kB gzip, CSS 6.6 kB, our pages' JS 0, Next
  runtime + Sentry ~245 kB gzip, and fonts 49–257 kB. `/login` scored 85 on the same setup.
- Root: `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9, DB suites against local Postgres),
  `pnpm --filter web build`, `pnpm generate` (no diff), `tokens:build --check`,
  `icons:build --check`, `i18n:build --check`, `openapi:build --check`,
  `node scripts/tasks.mjs check --local`. Android not built locally (one generated drawable added,
  same generator as T-029's icons; lint ignores unused `ic_cb_*`).

## Board log

- 2026-10-13T15:27:46.681Z claimed by agent-t087
- 2026-10-13T15:56:03.401Z completed on task/T-087-marketing-pricing-and-legal-pages
