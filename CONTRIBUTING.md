# Contributing to Ticketry

Ticketry is licensed under the Apache License, Version 2.0. Unless explicitly
stated otherwise, any contribution intentionally submitted for inclusion in
the project is licensed under the same terms, without additional conditions.
A separate contribution agreement, when one exists, continues to govern the
contribution. See [LICENSE](LICENSE), [NOTICE](NOTICE), and
[PROVENANCE.md](PROVENANCE.md).

## Before making a change

- Open or reference an issue that explains the goal, affected paths,
  constraints, and expected verification.
- Keep changes focused. Avoid unrelated refactors or formatting.
- Do not add secrets, credentials, personal data, or customer data. The seed
  file contains fictional workspaces only.
- Record the license of any new dependency.

## Working on the code

- `packages/core` holds the rules and queries; `apps/api` is only the HTTP
  layer and `apps/worker` is only scheduling. Put shared behaviour in `core`.
- Every business row belongs to a workspace. Queries that read or write
  workspace data take the workspace id explicitly; never rely on a caller
  having filtered earlier.
- Write to the audit log inside the same transaction as the change it records.
- Public API shapes are contracts: add fields, do not rename or remove them
  without a deprecation note in the PR.

## Database changes

- Add a new `packages/db/migrations/NNNN_name.sql`. Applied migrations are
  immutable; the runner refuses to start when one changed.
- Grant the `ticketry_app` role exactly what the runtime needs, and nothing
  else. It must never own objects.
- Keep migrations restartable: use `IF NOT EXISTS` where a rerun after a
  partial failure is plausible, and keep each file to one concern.

## Validation

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Integration tests need PostgreSQL (see the README). Add a test in the package
you changed: a repository test in `packages/core` needs an HTTP or job test
alongside it when the behaviour is reachable from the outside.

## Review

Submit changes through a pull request into `dev` with a short description of
the behaviour, the validation performed, and any known limitations.
