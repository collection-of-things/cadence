#!/usr/bin/env bash
# Launch Cadence with the env this dev box needs (no kernel userns).
cd "$(dirname "$0")/../apps/desktop"
export ELECTRON_DISABLE_SANDBOX=1
unset ELECTRON_RUN_AS_NODE
exec ./node_modules/.bin/electron . "$@"
