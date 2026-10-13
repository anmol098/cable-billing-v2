---
id: T-004
title: i18n package (en + hi) and generators
phase: 0
area: i18n
status: claimed
owner: agent-t004
claimed_at: 2026-10-13T04:31:35.597Z
branch: task/T-004-i18n-package-en-hi-and-generators
depends_on: [T-001]
review: self
claimable_by: agent
size: M
paths: [packages/i18n/**, apps/web/messages/**, apps/android/app/src/main/res/values/strings_generated.xml, apps/android/app/src/main/res/values-hi/strings_generated.xml]
---

# T-004 — i18n package (en + hi) and generators

**Phase** 0 · **Area** i18n · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-001

## Goal

One bilingual message source for web and Android, organised to avoid merge conflicts between parallel tasks.

## Scope

- Source layout: `packages/i18n/messages/{en,hi}/<namespace>.json`, one namespace per feature (common, auth, customers, connections, plans, bills, payments, linemen, reports, settings, admin, mobile_*).
- `glossary.md`: the fixed term list (Bill not Invoice, Connection (VC), Saved on phone, Sent to office, …) in both languages.
- Generator: merges namespaces into `apps/web/messages/{en,hi}.json` (next-intl format) and into Android `strings_generated.xml` (keys `ns_key`, only namespaces prefixed `mobile_` + `common`).
- Checks: every key exists in both languages, no unused placeholder mismatch, ICU plural syntax valid; `--check` mode for CI.
- Seed `common` namespace (app name 'Cable Billing' / 'केबल बिलिंग', yes/no, save, cancel, back, retry, call office, amount formats).

## Acceptance criteria

- [ ] Missing Hindi key fails `pnpm i18n:check`.
- [ ] Generated files are deterministic (sorted keys).

## Tests required

- Unit tests for merge, placeholder parity and Android XML escaping (apostrophes, `%`, `&`).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/i18n/**`
- `apps/web/messages/**`
- `apps/android/app/src/main/res/values/strings_generated.xml`
- `apps/android/app/src/main/res/values-hi/strings_generated.xml`

## Notes

- Hindi copy is drafted by agents and reviewed by the product owner (D-23, task H-03). Mark machine-drafted strings in `hi/*.json` with a `_review` list per namespace so the reviewer can find them.

## References

D-06, PLAN §2.2 rule 5, PLAN §11.4 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T04:31:35.597Z claimed by agent-t004
