# Ticketry

Ticketry is a multi-tenant helpdesk backend: an HTTP API for tickets, comments,
tags, saved views, full-text search, CSV exports, and an audit trail, plus a
worker that runs the background jobs (SLA breach sweeps, assignment digests,
export processing). Each customer organisation is a **workspace** (a tenant);
people are global identities that can belong to several workspaces, and
platform staff can act inside any workspace for support.

```text
clients ──HTTP──▶ apps/api ──┐
                             ├──▶ PostgreSQL 17 (single database, tenant_id on every business row)
scheduler ──────▶ apps/worker┘
```

## Ownership and license

Copyright 2026 Maxuel Guimarães Reis. Ticketry is licensed under the Apache
License, Version 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and
[PROVENANCE.md](PROVENANCE.md) for the complete licensing and provenance
information, and [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

## Workspaces

| Package | Role |
|---|---|
| `packages/db` | Connection pool, transaction helper, SQL migration runner, migrations, dev seed, throwaway-database helper for tests |
| `packages/core` | Domain rules (SLA, filters, CSV) and repositories shared by the API and the worker |
| `packages/test-support` | Vitest global setup (database bootstrap) and fixtures |
| `apps/api` | Fastify HTTP API |
| `apps/worker` | Background jobs, runnable once or on an interval |

## Requirements

- Node.js 24 (`.nvmrc`) with Corepack; the repository pins `pnpm@9.12.1`
- Docker with Compose, for the local PostgreSQL 17 server
- PostgreSQL client tools (`psql`) are optional but handy

## Quick start

```bash
corepack enable
pnpm install
pnpm db:up                       # PostgreSQL 17 on 127.0.0.1:5434
cp .env.example .env             # loaded automatically by the pnpm scripts below
pnpm db:migrate                  # applies packages/db/migrations as the owner
pnpm db:seed                     # two workspaces, five users, three tickets
pnpm dev:api                     # http://127.0.0.1:3000
pnpm dev:worker                  # runs every WORKER_INTERVAL_MS
```

Run one worker cycle by hand with `pnpm --filter @ticketry/worker start -- --once`,
optionally naming jobs: `sla-sweep`, `digest`, `exports`.

### Trying the API

Every request except `GET /health` carries `Authorization: Bearer <api key>`.
The seed's plain keys are listed at the top of `packages/db/seeds/dev-seed.sql`.

```bash
curl -s -H 'Authorization: Bearer tk_acme_agent_9a8b7c6d5e4f3a2b' localhost:3000/me
curl -s -H 'Authorization: Bearer tk_acme_agent_9a8b7c6d5e4f3a2b' localhost:3000/tickets
curl -s -H 'Authorization: Bearer tk_acme_agent_9a8b7c6d5e4f3a2b' 'localhost:3000/search?q=invoice'
```

Platform staff keys are not bound to a workspace; they name one per request
with `X-Ticketry-Tenant: <slug>`, and every such access is written to that
workspace's audit log.

## API

| Method and path | Notes |
|---|---|
| `GET /health` | Public. Reports the applied schema version. |
| `GET /me` | Caller, active workspace, and memberships. |
| `GET /users`, `GET /users/:id` | Active members of the workspace; a member profile. |
| `GET /tickets`, `POST /tickets` | Filters: `status`, `priority`, `assigneeId`, `tag`, `slaBreached`; paging: `limit` (≤100), `offset`. |
| `GET /tickets/:id`, `PATCH /tickets/:id` | Changing priority recomputes the SLA due time from creation. |
| `POST /lifecycle-events` | Staff-only provider event ingestion; requires `X-Ticketry-Tenant`. |
| `GET /tickets/:id/comments`, `POST /tickets/:id/comments` | Internal notes are hidden from viewers. |
| `GET /tags`, `GET /tickets/:id/tags`, `POST /tickets/:id/tags`, `DELETE /tickets/:id/tags/:name` | Tags are lowercase slugs, unique per workspace. |
| `GET /search?q=` | Full-text over subjects, bodies, and comments; one hit per ticket. |
| `GET /views`, `POST /views`, `GET /views/:id/tickets`, `DELETE /views/:id` | Saved filter sets. |
| `GET /exports`, `POST /exports`, `GET /exports/:id`, `GET /exports/:id/download` | Exports are queued and completed by the worker. |
| `GET /audit` | The workspace's audit trail, newest first. |

Roles: `owner` and `agent` can write, `viewer` is read-only, `staff` is the
platform support role. Errors are `{ "error": { "code", "message" } }`.

## Database

- One PostgreSQL database. Every business table carries `tenant_id`; users and
  API keys are global (staff keys have no tenant).
- Migrations are plain SQL files in `packages/db/migrations/`, named
  `NNNN_snake_case.sql`, applied in order by `packages/db/src/migrate.ts`. The
  runner records a checksum per file and refuses to run when an applied file
  changed. Never edit an applied migration; add a new one.
- The API and the worker connect as **`ticketry_app`**, a role that owns nothing
  and only holds the grants from `0003_app_role_grants.sql`. Migrations and
  seeds run as the database owner (`DATABASE_URL`).
- `docker-compose.yml` starts `postgres:17.4` on port `5434` and gives
  `ticketry_app` a local password on first boot.

## Development

```bash
pnpm lint        # eslint across the workspace
pnpm typecheck   # tsc --noEmit in every package
pnpm test        # vitest in every package
pnpm precommit:check
```

Integration tests need a PostgreSQL server. They read `DATABASE_URL` (an owner
connection to any database on that server); when it is unset they use the
Compose defaults and start the `db` service themselves if Docker is available.
Each test file creates its own migrated database and drops it at the end, so
suites run in parallel without sharing state. CI runs the same commands against
a `postgres:17.4` service container.
