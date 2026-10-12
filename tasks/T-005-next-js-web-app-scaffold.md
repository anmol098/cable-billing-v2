---
id: T-005
title: Next.js web app scaffold
phase: 0
area: web
status: todo
owner:
claimed_at:
branch:
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

- [ ] `pnpm --filter web build` succeeds without any env except defaults.
- [ ] A test page renders Hindi text in Noto Sans Devanagari and amounts in tabular figures.

## Tests required

- Vitest + Testing Library set up with one component test.
- Playwright installed with one smoke test against `next start` (health + home).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/**`

## References

PLAN §4, PLAN §5, PLAN §6.3, E-06, E-08 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
