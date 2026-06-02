#!/usr/bin/env bash
# Probe common Postgres credentials. Exits 0 with the working URL printed
# to stdout on success.
set -u

attempts=(
  "postgres://postgres:postgres@localhost:5432/medic"
  "postgres://postgres:postgres@localhost:5432/postgres"
  "postgres://medic:password@localhost:5432/medic"
  "postgres://medic:medic@localhost:5432/medic"
  "postgres://postgres:password@localhost:5432/postgres"
  "postgres://postgres:password@localhost:5432/medic"
)

for url in "${attempts[@]}"; do
  if psql "$url" -c 'select 1' >/dev/null 2>&1; then
    echo "$url"
    exit 0
  fi
done

echo "no working postgres url found" >&2
exit 1
