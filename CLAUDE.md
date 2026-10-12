# Cable Billing: agent instructions

Multi-tenant billing and field-collection SaaS for local cable operators in India.
Web (Next.js on Vercel + Neon Postgres) for operators. Native Android (Kotlin) for linemen.

## Start here

- **Source of truth:** `docs/BRD.md` (business rules), `docs/PRD.md` (requirements). They override everything else.
- **How we build it:** `docs/IMPLEMENTATION_PLAN.md` (decisions `D-xx`, architecture, data model, algorithms).
- **What to work on:** the task board in `tasks/`. **Read `tasks/README.md` before doing any work.**
  Claim a task with `node scripts/tasks.mjs claim <ID>` before you touch code.

## Commands

> T-001 (monorepo scaffold) replaces this section with the real commands.

```bash
node scripts/tasks.mjs next        # tasks you can claim
pnpm install                        # after T-001
pnpm lint && pnpm typecheck && pnpm test
pnpm generate                       # tokens, icons, i18n, openapi
cd apps/android && ./gradlew ktlintCheck detekt testDevDebugUnitTest assembleDevDebug
```

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
