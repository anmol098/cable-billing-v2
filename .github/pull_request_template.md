<!--
Title: "T-xxx: <task title>" (one task per PR, into feature/mvp). See tasks/README.md §3.
Dependency bumps and other non-task PRs: write "none" for the task and delete what does not apply.
-->

## Task

T-xxx: <!-- task ID and title; link the task file: tasks/T-xxx-….md -->

## Summary

<!-- What changed and why, in a few bullets. Interfaces other tasks will use. -->

-

## How it was verified

<!-- Commands you ran and what they showed. Real results only; say what you could not verify. -->

-

## Screenshots (UI changes)

<!-- Web: desktop and phone width, en and hi. Android: device or Compose preview. Delete if no UI. -->

## Notes for reviewers and later tasks

<!-- Decisions, deviations from the plan (and why), follow-up tasks created (T-xxxa), conflicts with the docs. -->

## Checklist (tasks/README.md §3.5 and §5)

- [ ] Every acceptance criterion in the task file is met and ticked.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` (and `pnpm build`) pass.
- [ ] Android: `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug` passes in `apps/android` (or no Android change).
- [ ] Generated files regenerated and committed (`pnpm generate`); `--check` modes pass.
- [ ] No hard-coded colours, sizes or user-facing strings: tokens and i18n keys only, `en` and `hi` both present (machine-drafted Hindi listed in `_review`).
- [ ] Money is integer paise; times are UTC `timestamptz`; business dates are IST.
- [ ] Tenant-scoped code goes through `withTenant` / `defineService`, with isolation-harness cases; financial records stay append-only.
- [ ] Only the task's owned paths plus the shared files in §6 are changed; nothing in another agent's claimed task.
- [ ] No secrets, `.env` files, legacy dump data or real personal data in the diff.
- [ ] No tests skipped or deleted and no safety relaxed to get green; decisions (`D-xx`) and BRD/PRD untouched.
- [ ] `node scripts/tasks.mjs check --local` passes.
- [ ] Completion notes filled in, `node scripts/tasks.mjs complete T-xxx` run, branch rebased on `origin/feature/mvp`.
