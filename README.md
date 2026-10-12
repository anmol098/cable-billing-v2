# Cable Billing v2

Multi-tenant billing and field-collection platform for local cable TV operators in India.

- **Web** (operators, office staff, platform admin): Next.js on Vercel, Postgres on Neon, Tailwind CSS v4
- **Android** (linemen): native Kotlin, offline-first

## Documents (source of truth)

| Document | Purpose |
|---|---|
| [`docs/BRD.md`](docs/BRD.md) | Business requirements, policies and business rules |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements, functional requirements and acceptance criteria |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Architecture, decisions log, design system, data model and delivery phases |
| [`tasks/README.md`](tasks/README.md) | **Task board**: every unit of work, plus the guide for agents on claiming and merging tasks |

The original RTF versions of the BRD/PRD are kept in `docs/` alongside the Markdown copies.

## Working on this repo

Work is organised as claimable tasks in [`tasks/`](tasks/). Agents (and humans) claim a task atomically,
build it in an isolated git worktree, and merge it into the integration branch `feature/mvp`:

```bash
node scripts/tasks.mjs next          # what can be claimed now
node scripts/tasks.mjs claim T-001   # atomic claim
```

See [`tasks/README.md`](tasks/README.md) for the full workflow and [`CLAUDE.md`](CLAUDE.md) for conventions.
