#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${1:-services/audio/target/debug/cadence-audio}"
exec timeout 120 node scripts/probe-audio.mjs "$BIN"
