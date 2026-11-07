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
step "loom ring model" && timeout 600 cargo run --manifest-path services/audio/loom-check/Cargo.toml --release || fail=1
step "audio fixtures + headless playback probe" && \
  timeout 300 bash scripts/gen-fixtures.sh && \
  timeout 300 bash scripts/probe-audio.sh || fail=1
step "e2e smoke (real app, private PipeWire tap)" && \
  if command -v Xvfb >/dev/null 2>&1 && command -v pactl >/dev/null 2>&1 \
     && command -v pw-dump >/dev/null 2>&1 && command -v wireplumber >/dev/null 2>&1; then
    timeout 420 .agents/skills/verify-cadence/helpers/cadence-verify run smoke || fail=1
  else
    # The e2e skill needs a private X display + PipeWire session stack +
    # the Electron binary — present on dev machines, absent on CI
    # runners. Skip loudly rather than fake-pass.
    echo "SKIP — Xvfb/pactl/pw-dump/wireplumber absent (run locally for e2e)"
  fi
echo
if [ "$fail" -eq 0 ]; then echo "VERIFY: PASS"; else echo "VERIFY: FAIL"; exit 1; fi
