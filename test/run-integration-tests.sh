#!/usr/bin/env bash
# Starts wrangler dev, runs one or more integration test files, and tears down.
# Usage: test/run-integration-tests.sh [test-file ...]
set -euo pipefail

PORT="${PORT:-8787}"
LOG="$(mktemp)"
TEST_FILES=("$@")

if [ "${#TEST_FILES[@]}" -eq 0 ]; then
  TEST_FILES=("test.mjs")
fi

cleanup() {
  kill "$WRANGLER_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

# macOS arm64 workaround for sandbox-sdk#522
export MINIFLARE_CONTAINER_EGRESS_IMAGE="${MINIFLARE_CONTAINER_EGRESS_IMAGE:-cloudflare/proxy-everything:3cb1195@sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c}"

echo "Starting wrangler dev on port $PORT..."
npx wrangler dev --port "$PORT" > "$LOG" 2>&1 &
WRANGLER_PID=$!

for _ in $(seq 1 30); do
  if grep -q "Ready on" "$LOG" 2>/dev/null; then
    echo "Server ready on port $PORT"
    break
  fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "wrangler exited unexpectedly:"
    cat "$LOG"
    exit 1
  fi
  sleep 1
done

if ! grep -q "Ready on" "$LOG" 2>/dev/null; then
  echo "Timed out waiting for wrangler dev"
  cat "$LOG"
  exit 1
fi

for test_file in "${TEST_FILES[@]}"; do
  echo "Running $test_file..."
  WS_BASE_URL="ws://localhost:$PORT/ws" node --test "$test_file"
done
