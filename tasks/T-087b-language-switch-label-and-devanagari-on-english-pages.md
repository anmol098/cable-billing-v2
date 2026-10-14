---
id: T-087b
title: Language switch label (accessible name, Devanagari font on English pages)
phase: 4
area: web-ui
status: claimed
owner: agent-t087b
claimed_at: 2026-10-14T20:57:22.784Z
branch: task/T-087b-language-switch-label-accessible-name-de
depends_on: [T-087a]
review: self
claimable_by: agent
size: S
paths: [packages/ui/src/composites/LanguageSwitch.tsx, packages/ui/src/composites/layout.test.tsx, apps/web/src/components/locale-switch.tsx]
---

# T-087b — Language switch label (accessible name, Devanagari font on English pages)

**Phase** 4 · **Area** web-ui · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-087a

## Goal

The `EN | हिं` switch passes Lighthouse's `label-content-name-mismatch` audit, and English pages
stop downloading the 121 KB Noto Sans Devanagari face only to draw the three letters of "हिं".

## Scope

- **Accessible name** (found in T-087, still open after T-087a): each button's visible text is
  the short form (`EN`, `हिं`) but its `aria-label` is the full name (`English`, `हिंदी`), so
  Lighthouse flags `label-content-name-mismatch` on every page (WCAG 2.5.3 "label in name"). Make
  the accessible name contain the visible text, e.g. `aria-label="हिं, हिंदी"` or the full name in a
  visually hidden span after the short form. Keep `getByRole("button", { name: "हिंदी" })` working
  (substring match) or update the e2e callers (`smoke.spec.ts`, `marketing.spec.ts`, others that
  switch language) in the same PR.
- **Font on English pages:** the Devanagari `@font-face` is global (`apps/web/src/app/fonts.ts`),
  so any Devanagari letter on a page downloads the whole face (121 KB), and the switch puts "हिं" on
  every English page. A face cannot be chosen per locale from `fonts.ts` alone (T-087a tried:
  `unicode-range` cannot tell the switch from Hindi content, and a partial "हिं"-only face would
  split Hindi clusters across two faces). Options: a design token for a system font stack
  (`system-ui`, which is Noto Sans Devanagari on Android) used by the switch's other-script button;
  or registering the web face only when `<html lang="hi">`. Decide with the design-token owner
  (no hard-coded font names).

## Out of scope

- Changing the switch's look or its no-JavaScript form.

## Acceptance criteria

- [ ] Lighthouse shows no `label-content-name-mismatch` on `/`, `/login`, `/home` in en and hi.
- [ ] On English pages without Devanagari content, no Devanagari font file is requested; Hindi
      pages still render in Noto Sans Devanagari (`e2e/smoke.spec.ts`).

## Tests required

- Component test for the accessible names; an e2e check of the fonts an English page requests.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/ui/src/composites/LanguageSwitch.tsx`, `packages/ui/src/composites/layout.test.tsx`, `apps/web/src/components/locale-switch.tsx`

## References

PLAN §2.2 rule 10 (language one tap away), PLAN §6.3 (fonts), T-087a completion notes (measured
cost: in T-087a's Lighthouse runs, blocking the face on English pages did not move the score
measurably on a busy machine; it is 121 KB of transfer on a first visit).

## Completion notes

_The agent fills this in before opening the PR._

## Board log

- 2026-10-14T20:57:22.794Z claimed by agent-t087b
