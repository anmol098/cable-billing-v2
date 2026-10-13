# Cable Billing: agent instructions

Multi-tenant billing and field-collection SaaS for local cable operators in India.
Web (Next.js on Vercel + Neon Postgres) for operators. Native Android (Kotlin) for linemen.

## Start here

- **Source of truth:** `docs/BRD.md` (business rules), `docs/PRD.md` (requirements). They override everything else.
- **How we build it:** `docs/IMPLEMENTATION_PLAN.md` (decisions `D-xx`, architecture, data model, algorithms).
- **What to work on:** the task board in `tasks/`. **Read `tasks/README.md` before doing any work.**
  Claim a task with `node scripts/tasks.mjs claim <ID>` before you touch code.
- **Picking up after an environment change?** Read `docs/HANDOFF.md` (current state, blockers, next wave, lessons learned).

## Commands

Node 24 (`.nvmrc`) and pnpm via Corepack (`corepack enable pnpm`; the version is pinned in `package.json` `packageManager`).

```bash
node scripts/tasks.mjs next              # tasks you can claim
pnpm install                             # whole workspace (engine-strict: needs Node >= 24)
pnpm lint                                # Biome check (lint + format + imports) on the repo, then turbo `lint`
pnpm lint:fix                            # apply Biome's safe fixes and formatting
pnpm format                              # Biome format only
pnpm typecheck                           # turbo: tsc --noEmit in every package
pnpm test                                # turbo: vitest run in every package
pnpm build                               # turbo: build every package/app
pnpm generate                            # turbo: tokens, icons, i18n, openapi generators
pnpm tokens:build [--check]              # tokens.json → theme.css + Tokens.kt (--check: fail on drift)
pnpm icons:build [--check]               # icons.json → @cb/ui <Icon> data + Android ic_cb_*.xml drawables
pnpm --filter @cb/domain test            # one package (any script, any @cb/* package)
pnpm --filter @cb/domain exec vitest     # watch mode for one package
pnpm --filter web dev                    # Next.js dev server for apps/web (http://localhost:3000)
pnpm --filter web build && pnpm --filter web test:e2e   # Playwright smoke tests against `next start`
cd apps/android && ./gradlew ktlintCheck detekt testDevDebugUnitTest assembleDevDebug
```

Definition of done for TS changes: `pnpm lint && pnpm typecheck && pnpm test` (and `pnpm build` once apps exist).

**Workspace conventions (from T-001)**

- Packages are `@cb/<name>` in `packages/<name>`; apps go in `apps/<name>`; tools in `tools/<name>`. All three globs are in `pnpm-workspace.yaml`, so a new folder with a `package.json` is picked up by `pnpm install`.
- Library packages are **source-only**: `exports` points at `src/index.ts`, there is no `dist`. Next.js bundles them (`transpilePackages`), Vitest reads TS directly, Node scripts run with `tsx`. Their `build` script is a no-emit compile check.
- Each package has `tsconfig.json` extending `@cb/config/tsconfig.lib.json` (apps/web: `@cb/config/tsconfig.next.json`), a `vitest.config.ts`, tests as `src/**/*.test.ts`, and scripts `build`, `typecheck`, `test` (add `generate`/`dev`/`lint` only if the package needs them).
- Shared tool versions come from the pnpm catalog: write `"typescript": "catalog:"` etc. (see `pnpm-workspace.yaml`). Depend on other packages with `"@cb/domain": "workspace:*"`.
- Formatting is Biome's (2 spaces, double quotes, semicolons, trailing commas, width 100). Don't hand-format; run `pnpm lint:fix`.
- `packages/domain/src` may not import Node built-ins (Biome `noNodejsModules`): keep it pure.

## Non-negotiable conventions

- **Users have low literacy** (linemen: illiterate or nearly literate; operators: mid-literate). Follow the UX rules in PLAN §2.2: one job per screen, icon + colour + short word, numbers first, plain words from `packages/i18n/glossary.md`.
- **Design tokens only.** Colours, type, radius, borders, spacing and sizes come from `packages/design-tokens/tokens.json` via generated files. Never hard-code them. Hyper-minimal: no shadows, no gradients.
- **i18n only.** Every user-facing string is a key in `packages/i18n/messages/{en,hi}/<namespace>.json`. Hindi is required.
- **Money** is integer **paise** (`*_paise`, `bigint` in the DB). The UI uses whole rupees. Never use floats for money.
- **Time:** store `timestamptz` UTC. Business dates and billing periods use `Asia/Kolkata`.
- **Tenancy:** every tenant query goes through `withTenant` / `defineService` in `packages/core`. Never trust an `operator_id` from the client. Cross-tenant ids return NOT_FOUND. Add isolation-harness cases for every new service.
- **Financial records are append-only.** No UPDATE/DELETE of posted payments, issued invoices, allocations or ledger entries. Corrections are reversals or adjustments.
- **Honest states:** never claim a WhatsApp/SMS message was "sent" or "delivered". Only "opened" or "shared".
- **Never commit** secrets, `.env`, legacy database dumps or real customer data.

## Repo layout (target)

```text
apps/web            Next.js (UI + server actions + /api/mobile/v1 + cron + webhooks)
apps/android        Kotlin + Compose lineman app (package com.cablebilling.lineman)
packages/design-tokens  tokens.json → theme.css + Tokens.kt + icons
packages/i18n       en/hi messages → web messages + Android strings
packages/ui         React components (token-styled)
packages/domain     pure billing/allocation logic (no I/O)
packages/db         Drizzle schema, migrations, RLS
packages/core       services, auth, authz, jobs
packages/contracts  Zod mobile API contract → openapi.json
tools/migration     legacy MariaDB import
tasks/              the task board
```
