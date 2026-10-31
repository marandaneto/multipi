#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export WRANGLER_SEND_METRICS=false
PORT=${PORT:-8792}
OUT=${OUT:-/tmp/multipi-application-results}
mkdir -p "$OUT"
STATE=$(mktemp -d -t multipi-app.XXXXXX)
./node_modules/.bin/wrangler dev --local --config test/container/app-wrangler.jsonc --port "$PORT" --persist-to "$STATE" > "$OUT/wrangler.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -rf "$STATE"' EXIT
for i in $(seq 1 90); do
  if grep -q 'Ready on' "$OUT/wrangler.log"; then break; fi
  kill -0 "$PID"
  sleep 1
done
PROBE_URL="http://localhost:$PORT" node test/container/app-smoke.mjs
