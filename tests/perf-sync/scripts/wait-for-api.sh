#!/usr/bin/env bash
# Block until the API is responding, or fail after ~60s.
set -euo pipefail
url="${1:-http://medic:password@localhost:5988/api/info}"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "$url"; then exit 0; fi
  sleep 1
done
echo "wait-for-api: $url not ready after 60s" >&2
exit 1
