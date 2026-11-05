#!/usr/bin/env bash
# Capture UI screenshots headlessly. Builds the UI, serves it, runs the
# capture Electron script under Xvfb. Usage:
#   bash scripts/screenshot.sh <name> [eval-js] [wait-ms] [url-suffix]
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${1:-shot}"; EVAL="${2:-}"; WAIT="${3:-2500}"; SUFFIX="${4:-?cadence_mock=1}"
PORT="${CAPTURE_PORT:-4517}"

# serve apps/ui/dist if no dev server is up
if ! curl -s -o /dev/null "http://localhost:${PORT}/"; then
  (cd apps/ui && nohup npx vite preview --port "${PORT}" --strictPort >/tmp/vite-prev.log 2>&1 & echo $! > /tmp/vite-prev.pid)
  for i in $(seq 1 30); do curl -s -o /dev/null "http://localhost:${PORT}/" && break; sleep 0.3; done
fi

mkdir -p docs/design/screens
# electron resolves from apps/desktop's deps (.bin is the real binary)
if [ -n "${DISPLAY:-}" ] && timeout 5 xset -q >/dev/null 2>&1; then
  RUNNER=(env -u ELECTRON_RUN_AS_NODE)
else
  RUNNER=(env -u ELECTRON_RUN_AS_NODE xvfb-run -a)
fi
CMD=("${RUNNER[@]}" ../../node_modules/.pnpm/electron@45.1.0/node_modules/electron/dist/electron scripts/capture.cjs
  "--url=http://localhost:${PORT}/${SUFFIX}"
  "--out=../../docs/design/screens/${NAME}.png" "--wait=${WAIT}")
[ -n "$EVAL" ] && CMD+=("--eval=${EVAL}")
(cd apps/desktop && timeout 60 "${CMD[@]}")
