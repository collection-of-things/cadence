#!/usr/bin/env bash
# Runs every check that does not need a display or real provider accounts.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
step() { echo; echo "=== $* ==="; }
step "pnpm install (frozen)" && timeout 300 pnpm install --prefer-offline --frozen-lockfile || fail=1
step "typecheck" && timeout 300 pnpm -r typecheck || fail=1
step "build" && timeout 300 pnpm -r build || fail=1
step "unit tests" && timeout 300 pnpm -r test || fail=1
step "cargo build" && timeout 600 cargo build --manifest-path services/audio/Cargo.toml || fail=1
step "cargo test" && timeout 600 cargo test --manifest-path services/audio/Cargo.toml || fail=1
step "audio fixtures + headless playback probe" && \
  timeout 300 bash scripts/gen-fixtures.sh && \
  timeout 300 bash scripts/probe-audio.sh || fail=1
step "e2e smoke (real app, private PipeWire tap)" && \
  timeout 420 .agents/skills/verify-cadence/helpers/cadence-verify run smoke || fail=1
echo
if [ "$fail" -eq 0 ]; then echo "VERIFY: PASS"; else echo "VERIFY: FAIL"; exit 1; fi
