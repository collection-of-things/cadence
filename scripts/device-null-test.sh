#!/usr/bin/env bash
# Device-path null test: captures cadence's real PipeWire stream through a
# matched-rate null-sink tap, does the same for mpv, and null-tests the
# captures against each other and against the ffmpeg decode.
#
# Usage: scripts/device-null-test.sh [fixture.flac] [--bin PATH]
#
# Requires a live PipeWire session plus pw-cat/pw-link/pw-metadata, pactl,
# mpv, ffmpeg/ffprobe, and python3+numpy. The test temporarily makes a
# null sink the session default and forces the graph clock to the source
# rate — both are restored afterwards — so don't run it while audio you
# care about is playing.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=target/debug/cadence-audio
FILE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) BIN="$2"; shift 2 ;;
        *) FILE="$1"; shift ;;
    esac
done
FILE="${FILE:-test/fixtures/generated/stereo-44k1-16.flac}"

exec python3 scripts/device_null_test.py --bin "$BIN" "$FILE"
