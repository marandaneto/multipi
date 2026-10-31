#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export WRANGLER_SEND_METRICS=false
PORT=${PORT:-8791}
OUT=${OUT:-/tmp/multipi-native-results}
mkdir -p "$OUT"
./node_modules/.bin/wrangler dev --local --config test/container/wrangler.jsonc --port "$PORT" > "$OUT/wrangler.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
for i in $(seq 1 90); do
  if grep -q 'Ready on' "$OUT/wrangler.log"; then break; fi
  kill -0 "$PID"
  sleep 1
done
for endpoint in conformance backup cancel uncertain; do
  curl --fail-with-body --max-time 150 -sS "http://localhost:$PORT/$endpoint" > "$OUT/$endpoint.json"
done
node --input-type=module - "$OUT" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = name => JSON.parse(fs.readFileSync(`${process.argv[2]}/${name}.json`, 'utf8'));
const conformance = read('conformance');
assert.equal(conformance.length, 24);
assert.ok(conformance.every(c => c.status === 'passed'), JSON.stringify(conformance));
assert.equal(read('backup').verified.length, 6);
assert.equal(read('cancel').detachedWriterQuiescent, true);
assert.equal(read('uncertain').containerRunning, false);
console.log('Native conformance 24/24; backup/destroy/restore, detached cancellation, timer cleanup and uncertain-outcome fencing passed.');
console.log(JSON.stringify(read('backup')));
JS
