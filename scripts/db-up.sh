#!/usr/bin/env bash
# Start the local PostgreSQL container and wait until it accepts connections.
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

echo "[INFO] Starting ticketry-db..."
docker compose up -d --wait db

for _ in $(seq 1 30); do
  if docker exec ticketry-db pg_isready -U postgres >/dev/null 2>&1; then
    echo "[INFO] PostgreSQL is ready on 127.0.0.1:5434"
    exit 0
  fi
  sleep 1
done

echo "[ERROR] PostgreSQL did not become ready in time" >&2
exit 1
