#!/usr/bin/env bash
# Local convenience: the same checks CI runs, in the same order.
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

pnpm lint
pnpm typecheck
pnpm test
