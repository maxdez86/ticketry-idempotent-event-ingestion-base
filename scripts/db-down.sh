#!/usr/bin/env bash
# Stop the local PostgreSQL container. Pass --volumes to delete its data too.
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if [[ ${1:-} == "--volumes" ]]; then
  docker compose down --volumes
else
  docker compose down
fi
