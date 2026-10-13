---
id: T-001
title: Monorepo scaffold and tooling
phase: 0
area: repo
status: claimed
owner: agent-t001
claimed_at: 2026-10-13T04:21:44.727Z
branch: task/T-001-monorepo-scaffold-and-tooling
depends_on: []
review: self
claimable_by: agent
size: M
paths: [package.json, pnpm-workspace.yaml, turbo.json, biome.json, .nvmrc, .gitignore, .editorconfig, packages/config/**, packages/*/package.json, packages/*/tsconfig.json, packages/*/src/index.ts, packages/*/vitest.config.ts, CLAUDE.md]
---

# T-001 — Monorepo scaffold and tooling

**Phase** 0 · **Area** repo · **Size** M · **Review** self · **Claimable by** agent · **Depends on** —

## Goal

Create the empty monorepo skeleton every other task builds on.

## Scope

- pnpm workspaces + Turborepo with pipelines `build`, `lint`, `typecheck`, `test`, `dev`, `generate`.
- Node 24 LTS (`.nvmrc`, `engines`), TypeScript strict base config in `packages/config` (tsconfig.base.json, tsconfig.next.json, tsconfig.lib.json).
- Biome for lint + format at root; scripts `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`.
- Empty packages with package.json, tsconfig, `src/index.ts`, Vitest config: `@cb/domain`, `@cb/db`, `@cb/core`, `@cb/contracts`, `@cb/ui`, `@cb/i18n`, `@cb/design-tokens`.
- `.gitignore` covering node, Next.js, Turbo, Android/Gradle, `.env*` (except `.env.example`), `*.sql`/`*.dump` legacy dumps, `tools/migration/data/`.
- Update `CLAUDE.md` 'Commands' section with the real commands.

## Out of scope

- apps/web and apps/android (separate tasks).

## Acceptance criteria

- [ ] `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass on a clean clone.
- [ ] Each package builds/tests in isolation via `pnpm --filter`.
- [ ] No dependency on anything outside the repo besides npm registry.

## Tests required

- A trivial passing test in each package proves Vitest wiring.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `package.json`
- `pnpm-workspace.yaml`
- `turbo.json`
- `biome.json`
- `.nvmrc`
- `.gitignore`
- `.editorconfig`
- `packages/config/**`
- `packages/*/package.json`
- `packages/*/tsconfig.json`
- `packages/*/src/index.ts`
- `packages/*/vitest.config.ts`
- `CLAUDE.md`

## References

PLAN §4, PLAN §5, E-01, E-10, E-11 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T04:21:44.727Z claimed by agent-t001
