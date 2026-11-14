#!/usr/bin/env bash
cd "$(dirname "$0")/../apps/desktop"
exec node scripts/launch.mjs "$@"
