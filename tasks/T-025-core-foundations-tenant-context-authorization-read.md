---
id: T-025
title: Core foundations: tenant context, authorization, read-only guard, audit, logging
phase: 1
area: core
status: claimed
owner: agent-t025
claimed_at: 2026-10-13T12:24:56.652Z
branch: task/T-025-core-foundations-tenant-context-authoriz
depends_on: [T-021, T-024]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/context/**, packages/core/src/authz/**, packages/core/src/audit/**, packages/core/src/errors/**, packages/core/src/logging/**, packages/core/src/testing/**, packages/core/src/index.ts]
---

# T-025 — Core foundations: tenant context, authorization, read-only guard, audit, logging

**Phase** 1 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-021, T-024

## Goal

The guard rails every service runs inside.

## Scope

- `TenantContext { operatorId, userId, role, deviceId?, requestId }` built only from server session/token.
- `can(role, capability)` from the fixed matrix in PLAN §9.3; `assertRole`.
- `assertWritable(ctx, capability)` using subscription state with the read-only allowlist (D-13).
- Service wrapper `defineService({ capability, input: zod, run })` → validates input, checks role + writable, runs inside `withTenant`, writes audit event for sensitive capabilities, maps errors.
- Error codes (NOT_FOUND for cross-tenant, FORBIDDEN, VALIDATION, TENANT_READ_ONLY, CONFLICT …).
- Structured JSON logger (request_id, operator_id, no PII).
- **Tenant isolation harness**: helper that, for each registered service, seeds two tenants and asserts cross-tenant ids yield NOT_FOUND and no writes; plus a coverage test failing if any exported service is not registered with the harness.

## Acceptance criteria

- [ ] Role matrix is data-driven and unit-tested row by row.
- [ ] Coverage test fails when a new service is added without isolation cases.

## Tests required

- Unit tests for authz and writable allowlist; integration test of the harness on a sample service.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/context/**`
- `packages/core/src/authz/**`
- `packages/core/src/audit/**`
- `packages/core/src/errors/**`
- `packages/core/src/logging/**`
- `packages/core/src/testing/**`
- `packages/core/src/index.ts`

## References

PLAN §9.1, PLAN §9.3, PLAN §9.4, FR-001, FR-024, D-13, D-16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T12:24:56.653Z claimed by agent-t025
