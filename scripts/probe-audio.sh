#!/usr/bin/env bash
# Headless playback probe for cadence-audio. Requires fixtures
# (scripts/gen-fixtures.sh) and a built binary (cargo build).
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=target/debug/cadence-audio
FIX=test/fixtures/generated
[ -x "$BIN" ] || { echo "probe-audio: $BIN missing (run cargo build first)"; exit 1; }
[ -d "$FIX" ] || { echo "probe-audio: fixtures missing (run scripts/gen-fixtures.sh)"; exit 1; }
command -v python3 >/dev/null || { echo "probe-audio: python3 required"; exit 1; }

echo "== probe fixtures =="
for f in tone-440.flac tone-880.wav tone-660.mp3 tone-550.m4a tone-330-24bit96k.flac tagged.flac; do
  "$BIN" --probe "$FIX/$f" | python3 -c '
import json,sys
r = json.load(sys.stdin)
assert r["ok"], r
print(f'"'"'  {sys.argv[1]}: {r["codec"]} {r["sampleRateHz"]}Hz {r["channels"]}ch {r["durationMs"]}ms'"'"', r["bitDepth"])
' "$f"
done

echo "== decode to f32le =="
OUT=$(mktemp -d)/gapless-a.f32le
"$BIN" --decode "$FIX/gapless-a.flac" --out "$OUT"
python3 - "$OUT" <<'PY'
import os, sys
size = os.path.getsize(sys.argv[1])
assert size == 44100 * 3 * 4, f"decode size {size}"
print(f"  decoded {size} bytes (3s @ 44.1k mono f32) OK")
PY

echo "== null-sink playback: load + prefetch gapless =="
DUMP=$(mktemp -d)/render.f32le
A="$PWD/$FIX/gapless-a.flac"
B="$PWD/$FIX/gapless-b.flac"
RPCOUT=$(mktemp)
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"audio.ping","params":{}}'
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"audio.load\",\"params\":{\"queueId\":\"qa\",\"generationId\":1,\"source\":{\"kind\":\"file\",\"path\":\"$A\"}}}"
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"audio.prefetch\",\"params\":{\"queueId\":\"qb\",\"path\":\"$B\",\"generationId\":1}}"
  sleep 7
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"audio.shutdown","params":{}}'
} | timeout 30 "$BIN" --null-sink --null-rate 44100 --null-dump "$DUMP" > "$RPCOUT"

python3 - "$DUMP" "$RPCOUT" <<'PY'
import json, os, sys, struct

dump, rpcout = sys.argv[1], sys.argv[2]
ended_gapless = started_gapless = ended_final = False
for line in open(rpcout):
    try:
        m = json.loads(line)
    except json.JSONDecodeError:
        continue
    meth, p = m.get("method"), m.get("params", {})
    if meth == "event.trackEnded" and p.get("queueId") == "qa":
        ended_gapless = p.get("gapless") is True
    if meth == "event.trackStarted" and p.get("queueId") == "qb":
        started_gapless = p.get("gapless") is True
    if meth == "event.trackEnded" and p.get("queueId") == "qb":
        ended_final = True
assert ended_gapless, "trackEnded(qa) was not gapless"
assert started_gapless, "trackStarted(qb) was not gapless"
assert ended_final, "qb never ended"

# Boundary continuity: rendered stream must contain no inserted silence.
raw = open(dump, "rb").read()
samples = struct.unpack(f"<{len(raw)//4}f", raw)
nz = next((i for i, s in enumerate(samples) if s != 0.0), len(samples))
last = len(samples) - 1 - next((i for i, s in enumerate(reversed(samples)) if s != 0.0), len(samples))
run = best = 0
for s in samples[nz:last]:
    run = run + 1 if s == 0.0 else 0
    best = max(best, run)
assert best <= 4, f"inserted silence at boundary: {best} zero samples"
print(f"  gapless boundary OK, rendered {(last-nz)//2} stereo frames, max zero run {best}")
PY

echo
echo "PROBE-AUDIO: PASS"

echo "== extended checks (probe-audio.mjs) =="
node scripts/probe-audio.mjs "$BIN" || true
