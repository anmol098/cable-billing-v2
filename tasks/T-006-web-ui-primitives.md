---
id: T-006
title: Web UI primitives
phase: 0
area: web-ui
status: todo
owner:
claimed_at:
branch:
depends_on: [T-005]
review: self
claimable_by: agent
size: M
paths: [packages/ui/src/primitives/**, packages/ui/src/lib/**, packages/ui/package.json]
---

# T-006 — Web UI primitives

**Phase** 0 · **Area** web-ui · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-005

## Goal

Accessible, token-only building blocks for mid-literacy users.

## Scope

- shadcn/ui-style (Radix) components restyled with tokens only: Button (primary/secondary/quiet/danger, loading), IconButton (always has visible label or aria-label + tooltip), Input, Textarea, Select, Checkbox, RadioCards (big option tiles).
- AmountInput: ₹ prefix, whole rupees only, numeric keyboard on mobile, returns paise (`bigint`-safe number) – uses `@cb/domain` money helpers when available, otherwise local helper to be swapped later.
- Amount: Indian grouping (₹1,23,456), due/credit colouring, tabular figures, sizes incl. `amount`.
- StatusPill: icon + colour + word (variants from PLAN §2.2 table).
- Card, Divider, Spinner, VisuallyHidden; `cn()` helper.
- Min control height 44px; focus ring uses `focus` token; no shadows.

## Acceptance criteria

- [ ] No hard-coded colours/sizes (Biome rule or grep check passes).
- [ ] All interactive primitives are keyboard accessible and pass axe checks.

## Tests required

- Component tests for AmountInput (rejects decimals/negatives, paise conversion) and Amount formatting (₹0, ₹99, ₹1,00,000, negatives as credit).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/ui/src/primitives/**`
- `packages/ui/src/lib/**`
- `packages/ui/package.json`

## References

PLAN §6.3, PLAN §6.4, PLAN §2.2, E-09 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
