---
id: T-001
title: Monorepo scaffold and tooling
phase: 0
area: repo
status: done
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

- [x] `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass on a clean clone.
- [x] Each package builds/tests in isolation via `pnpm --filter`.
- [x] No dependency on anything outside the repo besides npm registry.

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

**What exists**

- Root: `package.json` (`cable-billing`, `packageManager: pnpm@12.11.2`, `engines.node: >=24`), `pnpm-workspace.yaml`
  (globs `apps/*`, `packages/*`, `tools/*`; dev-tool **catalog**; `engineStrict: true`), `turbo.json`, `biome.json`,
  `.nvmrc` (`24`), `.editorconfig`, `.gitignore`, `pnpm-lock.yaml`. `apps/` and `tools/` are not created yet.
- `packages/config` (`@cb/config`): `tsconfig.base.json` (strict + `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noImplicitReturns`, `noUnused*`, `verbatimModuleSyntax`, `isolatedModules`, ES2024, `module: ESNext`,
  `moduleResolution: Bundler`, `noEmit`), `tsconfig.lib.json` (base + `types: ["node"]`), `tsconfig.next.json`
  (base + DOM libs, `jsx: react-jsx`, `allowJs`, `incremental`, `next` plugin). Its test asserts the base stays strict.
- Seven empty packages `@cb/domain`, `@cb/db`, `@cb/core`, `@cb/contracts`, `@cb/ui`, `@cb/i18n`, `@cb/design-tokens`,
  each with `package.json`, `tsconfig.json`, `turbo.json`, `vitest.config.ts`, `src/index.ts` (exports `packageName`)
  and `src/index.test.ts`.
- `CLAUDE.md` "Commands" section rewritten with the real commands and workspace conventions.

**Versions (latest stable on npm, 2026-10-13)**

pnpm 12.11.2 · turbo 2.11.7 · @biomejs/biome 2.5.15 (pinned exact: formatter output must not drift) ·
typescript 7.0.2 (native `tsc`) · vitest 5.0.3 (vite 8.3.4) · @types/node 24.19.2 (matches the Node 24 runtime).
vitest 5.0.4 was published the day before; pnpm 12's default minimum-release-age gate rejects it, so the catalog uses
`^5.0.3` instead of adding an exclusion. Next.js 16.4 supports TypeScript 7 (it runs the `tsc` CLI), so T-005 can
use the catalog version.

**Conventions later tasks must follow**

- New package: `packages/<name>/package.json` named `@cb/<name>`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`,
  devDependencies `"@cb/config": "workspace:*"`, `"@types/node" / "typescript" / "vitest": "catalog:"`. Scripts
  `build`, `typecheck` (both `tsc --noEmit`), `test` (`vitest run`); add `generate` / `dev` / `lint` only if needed.
- **Library packages are source-only (just-in-time)**: no `dist`, consumers import TS source. apps/web must list
  `@cb/*` in `transpilePackages`; Node scripts run with `tsx` (Node's own type stripping can't resolve
  extensionless imports). A library `build` is a no-emit compile check so `pnpm --filter <pkg> build` works; each
  package's `turbo.json` sets `build.outputs: []` so turbo doesn't warn. A package that starts emitting files
  (e.g. `dist/`) must update its own `turbo.json` outputs. Apps get the root default outputs (`dist/**`, `.next/**`).
- `tsconfig.json`: `{ "extends": "@cb/config/tsconfig.lib.json", "include": ["src", "vitest.config.ts"] }`.
  apps/web extends `@cb/config/tsconfig.next.json`. `@cb/ui` adds DOM libs and `jsx: react-jsx`.
- Tests: `src/**/*.test.ts` next to the code, imported explicitly from `vitest` (no globals).
- Turbo: `typecheck`, `test`, `lint` depend on a `transit` node (Turborepo's recommended pattern for source-only
  packages: parallel, but cache-invalidated when a dependency changes). `build` depends on `^build`. `generate`
  is uncached (generators write committed files outside the package). Root scripts: `build`, `dev`, `lint`,
  `lint:fix`, `format`, `typecheck`, `test`, `generate`, `tasks`. Add a root script only if your task needs one
  (e.g. `tokens:build`, `i18n:check`), delegating to the package.
- Biome runs once at the root (`biome check .`: lint + format + import sorting), then `turbo run lint` for any
  package-specific extra checks (none yet, so turbo reports 0 tasks). Ignored by Biome: `docs/`, `tasks/`,
  `scripts/tasks.mjs`, `apps/android/`, `**/generated/`, `**/*.generated.*`, `packages/ui/src/theme.css`,
  `packages/contracts/openapi.json`, `apps/web/messages/`, plus everything in `.gitignore`. Rules: recommended preset
  plus `noUnusedImports`, `noUnusedVariables`, `useImportType`, `useExportType`, `noNonNullAssertion`,
  `noExplicitAny` as errors; `noConsole` warns outside `**/scripts/**` and `tools/**`;
  **`packages/domain/src` (non-test) may not import Node built-ins** (`noNodejsModules`).
- `.gitignore` ignores `*.sql`/`*.dump`/`*.bak` legacy dumps everywhere except `packages/db/**/*.sql` (Drizzle
  migrations, RLS). T-090: if you need a committed synthetic SQL fixture, add a narrow `!tools/migration/...`
  exception. `tools/migration/data/`, `.env*` (except `.env.example`), keystores and `.claude/worktrees/` are ignored.
- Turbo 2.11 writes an `AGENTS.md` block when it detects an AI agent; `turbo.json` sets `"agentGuidance": false`
  so it doesn't. Turbo's bundled docs live in `node_modules/turbo/docs/` if you need version-accurate reference.

**Deviations**

- Added `packages/*/turbo.json` (one per package, not in the owned-path list) to silence turbo's "no output files"
  warnings for the no-emit library builds without weakening the root `build.outputs` that apps rely on.
- Test files `packages/*/src/index.test.ts` are outside the owned-path list but required by "Tests required".
- `@cb/domain` does not use `types: []` to forbid Node globals: Vitest's types pull `@types/node` in anyway, so
  the guard is the Biome `noNodejsModules` override instead.

**Verification** (fresh `git clone` of this branch into a scratch dir, Node v24.21.0, pnpm 12.11.2, `TURBO_FORCE=1`)

- `pnpm install --frozen-lockfile`: ok.
- `pnpm lint`: Biome checked 54 files, no errors; turbo lint 0 tasks.
- `pnpm typecheck`: 8/8 tasks successful. `pnpm test`: 8/8 tasks, every package's test passes.
- `pnpm build`: 8/8 tasks successful, no warnings.
- `pnpm --filter @cb/domain test` (1 passed) and `pnpm --filter @cb/ui build`: ok in isolation.
- Probes: a type error and an unchecked index in `@cb/domain` fail `tsc`; a `node:fs` import in
  `packages/domain/src` fails Biome.
- `node scripts/tasks.mjs check --local`: OK.

## Board log

- 2026-10-13T04:21:44.727Z claimed by agent-t001
- 2026-10-13T04:29:14.817Z completed on task/T-001-monorepo-scaffold-and-tooling
