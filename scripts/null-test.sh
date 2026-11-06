#!/usr/bin/env bash
# Null-test: render a file through the real engine graph (decode -> DSP ->
# resample -> ring -> pull) via the null sink, and compare the dump
# bit-exactly against `ffmpeg -i file -f f32le` decode.
#
#   scripts/null-test.sh <audio-file> [device-rate]
#
# Produces:
#   <tmp>/<file>.cadence.wav  — engine render, WAV (f32le)
#   <tmp>/<file>.ffmpeg.wav   — reference decode, WAV (f32le)
#   prints the residual: max abs diff and RMS in dBFS.
#
# The device-rate is the VIRTUAL device's default rate. When the device can
# accept the source's native format the engine opens the stream at the
# source rate (mpv-style) and the render must be bit-exact.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${CADENCE_BIN:-$REPO/target/debug/cadence-audio}"
FILE="$(realpath "$1")"
RATE="${2:-48000}"

[ -x "$BIN" ] || { echo "build first: cargo build -p cadence-audio" >&2; exit 1; }

TMP="$(mktemp -d /tmp/cadence-nulltest.XXXXXX)"
NAME="$(basename "$FILE")"
DUMP="$TMP/render.f32le"
RPC="$TMP/rpc.jsonl"

# Drive the JSON-RPC engine over stdio: load, wait through the track, stop.
python3 - "$BIN" "$FILE" "$RATE" "$DUMP" "$RPC" <<'PY'
import json, subprocess, sys, time

binary, path, rate, dump, rpc_out = sys.argv[1:6]
proc = subprocess.Popen(
    [binary, "--null-sink", "--null-rate", rate, "--null-dump", dump],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

def request(method, params, mid):
    proc.stdin.write(json.dumps(
        {"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n")
    proc.stdin.flush()

lines = []
request("audio.load", {
    "queueId": "q1", "generationId": 1,
    "source": {"kind": "file", "path": path},
}, 1)
deadline = time.time() + 120
ended = False
while time.time() < deadline:
    line = proc.stdout.readline()
    if not line:
        break
    lines.append(line.strip())
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if msg.get("method") == "event.trackEnded":
        ended = True
        break
time.sleep(0.3)  # let the dump writer flush
request("audio.shutdown", {}, 99)
proc.wait(timeout=10)
with open(rpc_out, "w") as f:
    f.write("\n".join(lines) + "\n")
if not ended:
    sys.exit("track never ended")
PY

python3 - "$DUMP" "$FILE" "$TMP/$NAME" "$RPC" <<'PY'
import json, subprocess, sys, numpy as np

dump, src, outbase, rpc = sys.argv[1:5]
cad = np.fromfile(dump, dtype="<f4")
ref = np.frombuffer(
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", src, "-f", "f32le", "-"],
        check=True, capture_output=True).stdout, dtype="<f4")

# Negotiated stream params as the engine reported them.
rate, ch = 44100, 2
for line in open(rpc):
    try:
        m = json.loads(line)
    except json.JSONDecodeError:
        continue
    if m.get("method") == "event.output":
        p = m["params"]
        rate, ch = int(p["sampleRateHz"]), int(p["channels"])
print(f"  negotiated stream: {rate} Hz x {ch}ch")

# Write both as f32 WAVs for easy inspection in any editor.
def wav(path, data, rate, ch):
    raw = data.astype("<f4").tobytes()
    hdr = (b"RIFF" + (36 + len(raw)).to_bytes(4, "little") + b"WAVEfmt "
           + (16).to_bytes(4, "little") + (3).to_bytes(2, "little")
           + ch.to_bytes(2, "little") + rate.to_bytes(4, "little")
           + (rate * ch * 4).to_bytes(4, "little") + (ch * 4).to_bytes(2, "little")
           + (32).to_bytes(2, "little") + b"data" + len(raw).to_bytes(4, "little"))
    with open(path, "wb") as f:
        f.write(hdr + raw)

wav(outbase + ".cadence.wav", cad, rate, ch)
wav(outbase + ".ffmpeg.wav", ref, 44100, 2)

nz = np.flatnonzero(np.abs(cad) > 1e-9)
rnz = np.flatnonzero(np.abs(ref) > 1e-9)
c = cad[nz[0]:]
r = ref[rnz[0]:]
n = min(len(c), len(r))
res = c[:n] - r[:n]
exact = np.array_equal(c[:n], r[:n])
rms = float(np.sqrt((res ** 2).mean())) if n else 0.0
print(f"{src}")
print(f"  cadence render: {len(cad)//ch} frames, reference: {len(ref)//2} frames")
print(f"  aligned samples: {n} | bit-exact: {exact} | "
      f"max|res|={np.abs(res).max():.3e} | rms={20*np.log10(max(rms,1e-20)):.1f} dBFS")
PY
echo "artifacts in $TMP"
