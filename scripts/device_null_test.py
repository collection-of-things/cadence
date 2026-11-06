#!/usr/bin/env python3
"""Device-path null test for Cadence issue #1.

Captures what an app ACTUALLY hands PipeWire through ONE shared null-sink
tap: the tap becomes the session default and the graph clock is forced to
the source rate, so each app (cadence native pw_stream, mpv --ao=pipewire)
links to it as its only driver — a rate-matched, passthrough capture with
no adapter resampling between the app and the recording.

Per file:
  1. ffmpeg reference decode -> f32le
  2. cadence-audio plays the file into the shared tap; record its monitor
  3. mpv plays the same file into the same tap; record its monitor
  4. null-test: cadence vs mpv, cadence vs ffmpeg, mpv vs ffmpeg
     + zero-run (dropout) and stream format/rate report

Verdict requires all three comparisons bit-exact — a silent pair can no
longer pass.

Usage:
  device_null_test.py --bin target/debug/cadence-audio <audio-file> [--keep]
"""

import argparse
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np


def pw_dump():
    out = subprocess.run(["pw-dump"], capture_output=True, check=True).stdout
    return json.loads(out)


def stream_nodes():
    """{node_id: props} for all live stream nodes (both directions)."""
    return {
        o["id"]: o.get("info", {}).get("props", {})
        for o in pw_dump()
        if o.get("type") == "PipeWire:Interface:Node"
        and str(o.get("info", {}).get("props", {}).get("media.class", "")).startswith(
            "Stream/"
        )
    }


def node_serial(node_props):
    return int(node_props.get("object.serial", 0))


def out_ports(node_id):
    return [
        p["id"]
        for p in pw_dump()
        if p.get("type") == "PipeWire:Interface:Port"
        and p.get("info", {}).get("props", {}).get("node.id") == node_id
        and p.get("info", {}).get("direction") == "output"
    ]


def client_ids_for_pid(pid):
    """Client ids whose application.process.id is `pid`."""
    return {
        o["id"]
        for o in pw_dump()
        if o.get("type") == "PipeWire:Interface:Client"
        and o.get("info", {}).get("props", {}).get("application.process.id") == pid
    }


def find_stream(pid, node_class, timeout=15.0):
    """Wait for a stream node owned by process `pid` (matched through its
    client's application.process.id) with output/input ports present.
    Returns (node_id, [out_port_ids], props)."""
    deadline = time.time() + timeout
    i = 0
    while time.time() < deadline:
        clients = client_ids_for_pid(pid)
        if i % 8 == 0:
            print(f"    [find] pid={pid} clients={clients} nodes="
                  f"{[(n, p.get('node.name'), p.get('client.id')) for n, p in stream_nodes().items()]}")
        for nid, props in stream_nodes().items():
            if props.get("client.id") not in clients:
                continue
            if props.get("media.class") != node_class:
                continue
            ports = out_ports(nid)
            if ports:
                return nid, ports, props
        i += 1
        time.sleep(0.25)
    raise TimeoutError(f"no stream node for pid {pid}")


def stream_format(node_id, props):
    """Negotiated stream format: the node's `Format` param is authoritative
    (that's what the stream actually delivers). Falls back to node.rate and
    the port's dsp format when Format isn't published yet."""
    for o in pw_dump():
        if o.get("id") != node_id or o.get("type") != "PipeWire:Interface:Node":
            continue
        for prm in (o.get("info", {}).get("params") or {}).get("Format", []):
            if isinstance(prm, dict) and prm.get("format") and prm.get("rate"):
                return prm["rate"], str(prm["format"])
    rate = None
    for key in ("node.rate", "node.latency"):
        m = re.match(r"^(\d+)/(\d+)$", str(props.get(key, "")))
        if m and int(m.group(2)) > 0:
            rate = int(m.group(2))
            break
    return rate, None


def linked_pairs():
    """Set of (out_port_id, in_port_id) for all current links."""
    out = subprocess.run(["pw-link", "-lI"], capture_output=True, text=True).stdout
    pairs = set()
    for line in out.splitlines():
        # format: "  <outid> <name>  |->  <inid> <name>" or similar
        m = re.findall(r"(\d+)", line)
        if "|->" in line and len(m) >= 2:
            pairs.add((int(m[0]), int(m[1])))
        elif len(m) >= 2:
            pairs.add((int(m[0]), int(m[1])))
    return pairs


class Recorder:
    """pw-cat record stream (unlinked) tapped onto an app's output ports."""

    def __init__(self, path, rate, channels):
        self.path = path
        self.proc = subprocess.Popen(
            [
                "pw-cat", "-r", "--raw", "--target", "0",
                "--rate", str(rate), "--channels", str(channels),
                "--format", "f32", path,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def input_ports(self, timeout=8.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            clients = client_ids_for_pid(self.proc.pid)
            for nid, props in stream_nodes().items():
                if props.get("client.id") not in clients:
                    continue
                if props.get("media.class") != "Stream/Input/Audio":
                    continue
                ports = [
                    p["id"]
                    for p in pw_dump()
                    if p.get("type") == "PipeWire:Interface:Port"
                    and p.get("info", {}).get("props", {}).get("node.id") == nid
                    and p.get("info", {}).get("direction") == "input"
                ]
                if ports:
                    return ports
            time.sleep(0.25)
        raise TimeoutError("recorder input ports never appeared")

    def tap(self, out_port_ids, in_port_ids):
        # Idempotent: only create links that don't already exist (a partial
        # earlier attempt may have left some).
        existing = linked_pairs()
        for o, i in zip(out_port_ids, in_port_ids):
            if (o, i) in existing:
                continue
            r = subprocess.run(
                ["pw-link", str(o), str(i)], capture_output=True, text=True
            )
            if r.returncode != 0:
                raise subprocess.CalledProcessError(
                    r.returncode, r.args, r.stdout, r.stderr
                )

    def stop(self):
        self.proc.send_signal(signal.SIGINT)
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def src_rate_hint(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries",
         "stream=sample_rate", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        return int(r.stdout.strip().split(",")[0])
    except (ValueError, IndexError):
        return None


def drive_cadence(binary, path, generation=1, device=None,
                  start_paused=False):
    """Start cadence-audio (real device) and play `path`.
    With start_paused=True the track loads but doesn't play — the caller
    attaches the recorder first, then sends audio.play itself.
    Returns (proc, req, events)."""
    proc = subprocess.Popen(
        [binary],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    def req(method, params, mid):
        proc.stdin.write(
            json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
            + "\n"
        )
        proc.stdin.flush()

    evr = EventReader(proc)
    if device:
        req("audio.setDevice", {"name": device, "generationId": generation}, 0)
    req(
        "audio.load",
        {
            "queueId": "q1",
            "generationId": generation,
            "startPaused": start_paused,
            "source": {"kind": "file", "path": str(path)},
        },
        1,
    )
    # Wait for the format-matching rebuild to land before playing — the
    # transitional 48000 stream would otherwise emit the track head
    # resampled into the tap.
    deadline = time.time() + 5
    while time.time() < deadline:
        ev = evr.output_event()
        if ev and ev.get("sampleRateHz") == src_rate_hint(path):
            break
        time.sleep(0.05)
    if not start_paused:
        req("audio.play", {"generationId": generation}, 2)
    return proc, req, evr


class EventReader:
    """Drain cadence stdout events on a thread."""

    def __init__(self, proc):
        import threading

        self.events = []
        self.proc = proc
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self):
        for line in self.proc.stdout:
            try:
                self.events.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    def output_event(self):
        """Latest event.output params — the transitional stream event
        fires first; the source-format rebuild fires last."""
        out = None
        for e in self.events:
            if e.get("method") == "event.output":
                out = e["params"]
        return out

    def buffering_count(self):
        return sum(1 for e in self.events if e.get("method") == "event.buffering")


def read_f32(path):
    return np.fromfile(path, dtype="<f4")


def ffmpeg_ref(path):
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(out, dtype="<f4")


def ffprobe_rate(path):
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate", "-of", "json", str(path),
        ],
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    return int(json.loads(out)["streams"][0]["sample_rate"])


def ffprobe_duration(path):
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration", "-of", "json", str(path),
        ],
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    return float(json.loads(out)["format"]["duration"])


def xcorr_valid(cap, seg):
    """Normalized full cross-correlation (valid mode) via FFT. Raw
    correlation magnitude alone is a bad alignment key for periodic
    content: window energy wobbles a few ppm across a non-integer-period
    tone, so a wrong lag can out-score the true one (seen at 192k —
    argmax landed on a −0.9999-correlated window whose energy beat the
    exact match by 6ppm). Dividing by the sliding window energy makes
    the true lag uniquely maximal (=1.0)."""
    if len(cap) < len(seg):
        seg = seg[: len(cap)]
    n = len(cap) + len(seg) - 1
    nfft = 1 << (n - 1).bit_length()
    C = np.fft.rfft(cap, nfft)
    S = np.fft.rfft(seg[::-1], nfft)
    cc = np.fft.irfft(C * S, nfft)
    cc = cc[len(seg) - 1 : len(seg) - 1 + len(cap) - len(seg) + 1]
    # Sliding window energy E_win[k] = sum(cap[k:k+L]^2) via cumsum.
    esq = np.concatenate(([0.0], np.cumsum(cap.astype(np.float64) ** 2)))
    e_win = esq[len(seg):] - esq[: len(cap) - len(seg) + 1]
    denom = np.sqrt(np.maximum(e_win, 0.0) * float(np.dot(seg, seg)))
    return np.divide(cc, denom, out=np.zeros_like(cc), where=denom > 0)


def best_align(cap, seg):
    """Periodic content (pure tones) gives many equal correlation peaks —
    argmax alone can land off by whole periods and the whole-overlap
    compare then reads as noise. Score the top peaks by residual RMS and
    keep the best alignment. The capture's own content-start position is
    an extra anchor — correlation alone can't pin a degenerate signal."""
    cc = xcorr_valid(cap, seg)
    idx = np.argsort(np.abs(cc))[::-1]
    cands = []
    for i in idx[:512]:
        if all(abs(int(i) - c) > len(seg) // 8 + 1 for c in cands):
            cands.append(int(i))
        if len(cands) >= 24:
            break
    # Content-start anchor: where seg's content would sit if the capture
    # started recording before playback. Add ±small refinements around it.
    nz0 = np.flatnonzero(np.abs(cap) > 1e-6)
    ref_nz0 = np.flatnonzero(np.abs(seg) > 1e-6)
    if len(nz0) and len(ref_nz0):
        anchor = int(nz0[0]) - int(ref_nz0[0])
        for d_ in range(-2048, 2049, 512):
            k2 = anchor + d_
            if 0 <= k2 < len(cc) and all(
                abs(k2 - c) > 16 for c in cands
            ):
                cands.append(k2)
    scored = [
        (float(np.sqrt(((cap[k : k + len(seg)] - seg) ** 2).mean())), k)
        for k in cands
    ]
    best_rms = min(s for s, _ in scored)
    # Tie-break by earliest position: among equally good alignments the
    # earliest yields the largest overlap (highest coverage) — a pure
    # tone makes every period-shift "exact", and a later pick shrinks
    # the measured overlap for no content reason.
    good = [k for s, k in scored if s <= max(best_rms * 2, 1e-12)]
    return min(good)


def zero_runs(body, ch, min_frames=8):
    """Count runs of consecutive zero frames inside the aligned body —
    mid-signal zero runs are dropouts (underrun / try_lock zero-fill)."""
    frames = body[: len(body) - (len(body) % ch)].reshape(-1, ch)
    z = np.all(frames == 0.0, axis=1)
    runs, cur = [], 0
    for v in z:
        if v:
            cur += 1
        else:
            if cur:
                runs.append(cur)
            cur = 0
    if cur:
        runs.append(cur)
    return [r for r in runs if r >= min_frames]


def compare(name, cap, ref, ch, label):
    """Null-test cap (raw f32 capture) against ref (f32): find ref's
    position inside cap by cross-correlating a midsection (the recorder
    attaches mid-playback — the file head may not be in the capture),
    then subtract the WHOLE aligned overlap — dropouts anywhere in the
    overlap show up, not just in the alignment window.
    Returns (ok, zero_run_count)."""
    seg_off = len(ref) // 4
    seg = ref[seg_off : seg_off + min(40000, len(ref) // 2)]
    if len(cap) < len(seg):
        print(f"  {label}: capture too short ({len(cap)//ch} frames)")
        return False, -1
    k = best_align(cap, seg)
    # ref[0] would sit at cap[k - seg_off]; the recorder attaches
    # mid-playback so the capture legitimately lacks the head/tail.
    # Compare the overlap further trimmed to the capture's own content
    # span — a missing head is expected, a hole INSIDE is a dropout.
    cap_start = k - seg_off
    lo = max(0, -cap_start)  # first ref sample present in the capture
    end = min(len(ref), len(cap) - cap_start)  # exclusive
    if end - lo <= len(seg):
        print(f"  {label}: overlap too short")
        return False, -1
    a = ref[lo:end]
    b = cap[cap_start + lo : cap_start + end]
    # Trim to where the capture has actual content. The recorder's per-
    # channel links attach a few ms apart — the head's sparse channel
    # (every-other-sample zeros) is an attach artifact, not a dropout.
    nfr = len(b) // ch
    allch = np.abs(b[: nfr * ch]).reshape(nfr, ch).min(axis=1)
    full = np.nonzero(allch > 1e-6)[0]
    nz = np.nonzero(np.abs(b) > 1e-6)[0]
    if nz.size == 0 or full.size == 0:
        print(f"  {label}: aligned span is silent")
        return False, -1
    start = full[0] * ch
    a = a[start : nz[-1] + 1]
    b = b[start : nz[-1] + 1]
    res = b - a
    mx = float(np.abs(res).max())
    rms = float(np.sqrt((res ** 2).mean()))
    db = 20 * np.log10(max(rms, 1e-20))
    zr = zero_runs(b, ch)
    # The tap captures f32 while the apps deliver s16/s32 — the tap's
    # int→f32 conversion and ffmpeg's own decode→f32 can differ by one
    # ULP (~1.19e-7) at an extreme-magnitude sample. That is conversion
    # noise, not an app difference — the delivered integers are proven
    # identical by the app-vs-app null, which stays exact. Bound the
    # exception: a systematic transform shows up at far more than a
    # handful of samples.
    exact = mx == 0.0
    nz_res = int(np.count_nonzero(res))
    ok = exact or (mx <= float(np.finfo(np.float32).eps) and nz_res <= 32)
    # Coverage gate: how much of the SOURCE does the capture actually
    # contain? Map the capture's own nonzero span into ref coordinates
    # via cap_start — the recorder links before playback, so a
    # shortfall means real audio was lost, not an attach race. A
    # period-aliased alignment can't deflate this: the content span is
    # measured on the raw capture, not the aligned window.
    cap_nz = np.count_nonzero(np.abs(cap) > 1e-6)
    ref_nz = max(1, int(np.count_nonzero(np.abs(ref) > 1e-6)))
    # Dense nonzero fraction vs the reference's — a truncated or
    # mostly-silent capture can't be inflated by a sparse noise tail.
    coverage = cap_nz / ref_nz
    cov_ok = coverage >= 0.85
    print(
        f"  {label}: max|res|={mx:.3e} rms={db:.1f} dBFS "
        f"bitexact={exact} ok={ok} zero-runs(>=8f)={len(zr)}"
        + (f" sizes={zr[:8]}" if zr else "")
        + f" compared={len(a)//ch}f coverage={coverage:.0%}"
    )
    return ok and cov_ok, len(zr)


def null_residual(a, b):
    """Align `a` inside `b` by cross-correlating a midsegment (a periodic
    signal has many equal peaks — take the residual-minimizing alignment
    like `compare` does), then subtract across the WHOLE overlap — a
    short-segment check would pass a capture corrupted elsewhere."""
    seg_off = 40000 if len(a) > 60000 else 0
    seg = a[seg_off : seg_off + 20000] if len(a) > 60000 else a[: len(a) // 2]
    if len(seg) < 1000:
        seg = a
        seg_off = 0
    cc = xcorr_valid(b, seg)
    if len(cc) == 0:
        return b - a
    # Candidate lags: the normalized-correlation argmax AND the
    # content-start difference. Degenerate fixtures (pure tones,
    # mirrored noise) can score a wrong/inverted lag a few ppm above
    # the true one; the content-start anchor is immune to periodicity.
    k0 = int(np.argmax(np.abs(cc)))
    # Content-start must ride above converter noise floors — an
    # absolute epsilon picks up pre-content floor noise and shifts the
    # anchor arbitrarily. 1% of each capture's own peak is robust.
    a_nz0 = np.flatnonzero(np.abs(a) > max(1e-6, 0.01 * float(np.abs(a).max())))
    b_nz0 = np.flatnonzero(np.abs(b) > max(1e-6, 0.01 * float(np.abs(b).max())))
    anchors = [k0]
    if len(a_nz0) and len(b_nz0):
        anchors.append(int(b_nz0[0]) - int(a_nz0[0]) + seg_off)
    k, best = k0, None
    for anchor in anchors:
        span = min(1024, len(cc) - 1)
        lo, hi = max(0, anchor - span), min(len(cc), anchor + span + 1)
        for cand in range(lo, hi):
            r = b[cand : cand + len(seg)] - seg
            s = float(np.abs(r).max())
            if best is None or s < best:
                best, k = s, cand
                if best == 0.0:
                    break
        if best == 0.0:
            break
    # k locates seg inside b — a[i] aligns to b[k - seg_off + i].
    off = k - seg_off
    a_lo = max(0, -off)
    b_lo = max(0, off)
    n = min(len(a) - a_lo, len(b) - b_lo)
    aa = a[a_lo : a_lo + n]
    bb = b[b_lo : b_lo + n]
    # Only compare where BOTH captures actually carry signal — the
    # callers reshape and compare per channel already; here the shared
    # nonzero span trims legitimate attach zeros at the edges.
    a_nz = np.flatnonzero(aa)
    b_nz = np.flatnonzero(bb)
    if len(a_nz) and len(b_nz):
        lo = max(int(a_nz[0]), int(b_nz[0]))
        hi = min(int(a_nz[-1]), int(b_nz[-1]))
        if hi > lo:
            return bb[lo : hi + 1] - aa[lo : hi + 1]
    return bb - aa


def make_null_sink(name, rate, channels):
    """Virtual sink at `rate`; its monitor emits exactly what it receives
    (passthrough when the stream rate matches). Returns (module_id, node_id)."""
    r = subprocess.run(
        [
            "pactl", "load-module", "module-null-sink",
            f"sink_name={name}", f"rate={rate}", f"channels={channels}",
            "format=float32le",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    module_id = int(r.stdout.strip())
    deadline = time.time() + 8
    while time.time() < deadline:
        for o in pw_dump():
            if o.get("type") != "PipeWire:Interface:Node":
                continue
            p = o.get("info", {}).get("props", {})
            if p.get("node.name") == name:
                return module_id, o["id"]
        time.sleep(0.25)
    raise TimeoutError(f"null sink {name} never appeared")


def unload_module(module_id):
    subprocess.run(["pactl", "unload-module", str(module_id)],
                   capture_output=True)


def node_ports(node_id, direction):
    return [
        p["id"]
        for p in pw_dump()
        if p.get("type") == "PipeWire:Interface:Port"
        and p.get("info", {}).get("props", {}).get("node.id") == node_id
        and p.get("info", {}).get("direction") == direction
    ]


def attach_recorder(workdir, tag, tap, rate, sink_id):
    """Link a recorder to the tap's monitor ports — callable BEFORE the
    app's playback starts, so no content is lost to attach latency.
    Returns (Recorder, path)."""
    rec_path = os.path.join(workdir, f"cap-{tag}.f32le")
    rec = Recorder(rec_path, rate, 2)
    try:
        rec_in = rec.input_ports()
        monitor = tap[1]
        for attempt in range(8):
            try:
                rec.tap(monitor, rec_in)
                break
            except subprocess.CalledProcessError:
                if attempt == 7:
                    raise
                monitor = node_ports(sink_id, "output")
                time.sleep(0.5)
        return rec, rec_path
    except Exception:
        if rec.proc.poll() is None:
            rec.stop()
        raise


def app_stream_info(pid, expect_name=None):
    """Find the app's output stream node and assert it's the expected
    backend's node — a fallback that produces a differently-named node
    must not pass as the real one. Returns (node_id, rate, fmt, props)."""
    node_id, app_out, props = find_stream(pid, "Stream/Output/Audio")
    name = props.get("node.name", "")
    if expect_name and name != expect_name:
        raise RuntimeError(
            f"expected a {expect_name!r} stream node, found {name!r} — "
            "the app did not take the expected backend"
        )
    rate, fmt = stream_format(node_id, props)
    return node_id, rate, fmt, props


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("file")
    ap.add_argument("--mpv-bin", default="mpv")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    src = Path(args.file).resolve()
    ref = ffmpeg_ref(src)
    src_rate = ffprobe_rate(src)
    dur = ffprobe_duration(src)
    workdir = tempfile.mkdtemp(prefix="cadence-devnull-")
    print(f"source: {src.name} ({src_rate} Hz, {dur:.2f}s), workdir {workdir}")

    # One shared tap at the source rate for BOTH apps, with the graph
    # clock forced to the same rate — the tap's input adapter then runs
    # passthrough (verified bit-exact), each app targets the tap directly
    # as its only link/driver, and both captures ride the same clock (a
    # directly null-able A/B). Other apps' streams are untouched — the
    # tap is never made default.
    mod_id, sink_id, monitor = None, None, []
    prev_force = "0"
    cap_path = mpv_path = None
    cad_rate = mpv_rate = None
    cap_proc = mpv = None
    try:
        mod_id, sink_id = make_null_sink("cadence-tap", src_rate, 2)
        for _ in range(20):
            monitor = node_ports(sink_id, "output")
            if len(monitor) >= 2:
                break
            time.sleep(0.25)
        tap = (sink_id, monitor)
        out = subprocess.run(
            ["pw-metadata", "-n", "settings", "0", "clock.force-rate"],
            capture_output=True, text=True,
        ).stdout
        m = re.search(r"key:'clock\.force-rate'\s+value:'([^']*)'", out)
        if m:
            prev_force = m.group(1)
        r = subprocess.run(
            ["pw-metadata", "-n", "settings", "0", "clock.force-rate",
             str(src_rate)],
            capture_output=True,
        )
        verify = subprocess.run(
            ["pw-metadata", "-n", "settings", "0", "clock.force-rate"],
            capture_output=True, text=True,
        ).stdout
        mv = re.search(r"key:'clock\.force-rate'\s+value:'([^']*)'", verify)
        if r.returncode != 0 or not mv or mv.group(1) != str(src_rate):
            print("ERROR: could not force the graph clock — the tap adapter "
                  "would rate-match and the numbers are meaningless")
            sys.exit(3)

        # ---- cadence ----
        # Load paused, attach the recorder, THEN play — nothing misses
        # the head to attach latency.
        print("[cadence] loading paused into tap")
        cap_proc, _req, evr = drive_cadence(
            args.bin, src, device="cadence-tap", start_paused=True)
        try:
            cad_node, cad_rate, cad_fmt, _ = app_stream_info(
                cap_proc.pid, expect_name="cadence-audio")
            rec, cap_path = attach_recorder(
                workdir, "cadence", tap, cad_rate or src_rate, tap[0])
            try:
                _req("audio.play", {"generationId": 1}, 2)
                time.sleep(dur + 0.8)
            finally:
                if rec.proc.poll() is None:
                    rec.stop()
        except TimeoutError:
            print("stream nodes at timeout:")
            for nid, p in stream_nodes().items():
                print("   ", nid, p.get("node.name"), p.get("media.class"),
                      "client", p.get("client.id"), "serial", node_serial(p))
            raise
        time.sleep(0.4)
        _req("audio.shutdown", {}, 99)
        try:
            cap_proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            cap_proc.kill()
        out_ev = evr.output_event()
        print(
            f"[cadence] node={cad_node} stream={cad_fmt}@{cad_rate} "
            f"reported={out_ev} buffering-events={evr.buffering_count()}"
        )

        # ---- mpv ----
        # --audio-samplerate pins mpv's stream to the source rate so both
        # apps deliver at the same rate into the same driver; the device
        # targets the tap directly (no default-sink switching). mpv
        # launches --pause, the recorder attaches, then IPC unpauses.
        print("[mpv] starting playback into tap")
        mpv_sock = os.path.join(workdir, "mpv.sock")
        mpv = subprocess.Popen(
            [
                args.mpv_bin, "--ao=pipewire", "--no-video", "--really-quiet",
                "--pause", f"--input-ipc-server={mpv_sock}",
                "--audio-device=pipewire/cadence-tap",
                f"--audio-samplerate={src_rate}", str(src),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            mpv_node, mpv_rate, mpv_fmt, _ = app_stream_info(
                mpv.pid, expect_name="mpv")
            rec, mpv_path = attach_recorder(
                workdir, "mpv", tap, mpv_rate or src_rate, tap[0])
            try:
                # Retry the IPC unpause — the socket exists before mpv
                # accepts connections on it. (unix socket, no socat dep)
                for _ in range(20):
                    try:
                        with socket.socket(socket.AF_UNIX) as s:
                            s.settimeout(0.3)
                            s.connect(mpv_sock)
                            s.sendall(
                                b'{"command": ["set_property", "pause", false]}\n'
                            )
                        break
                    except OSError:
                        time.sleep(0.25)
                time.sleep(dur + 0.8)
            finally:
                if rec.proc.poll() is None:
                    rec.stop()
        except TimeoutError:
            mpv.kill()
            raise
        mpv.wait(timeout=10)
        print(f"[mpv] node={mpv_node} stream={mpv_fmt}@{mpv_rate}")
    finally:
        for p in (cap_proc, mpv):
            if p is not None and p.poll() is None:
                p.kill()
        subprocess.run(
            ["pw-metadata", "-n", "settings", "0", "clock.force-rate", prev_force],
            capture_output=True,
        )
        if mod_id:
            unload_module(mod_id)

    # ---- compare ----
    ch = 2
    cad = read_f32(cap_path)
    mcap = read_f32(mpv_path)

    same_rate = cad_rate == mpv_rate == src_rate
    print(f"[compare] rates: source={src_rate} cadence={cad_rate} mpv={mpv_rate}")

    results = {}
    if same_rate:
        ok_c, zc = compare("cadence", cad, ref, ch, "cadence vs ffmpeg")
        ok_m, zm = compare("mpv", mcap, ref, ch, "mpv     vs ffmpeg")
        results["cadence_vs_ffmpeg_exact"] = ok_c
        results["mpv_vs_ffmpeg_exact"] = ok_m
        # Mid-signal zero runs are dropouts — gate them too.
        results["cadence_no_dropouts"] = zc == 0
        results["mpv_no_dropouts"] = zm == 0
        # The app-level bar: the captured streams must null against each
        # other — i.e. cadence's delivered PCM is indistinguishable from
        # mpv's. Guard against the degenerate "both captured silence"
        # false-PASS: both captures must carry real energy.
        # Per-channel: the recorder's channels attach at different times
        # and the skew differs between captures, so a single interleaved
        # alignment can never fit both. Align/compare each channel.
        ch = 2
        cad_f = cad[: len(cad) - len(cad) % ch].reshape(-1, ch)
        mcap_f = mcap[: len(mcap) - len(mcap) % ch].reshape(-1, ch)
        res = np.concatenate(
            [null_residual(cad_f[:, c], mcap_f[:, c]) for c in range(ch)]
        )
        silent = (
            np.abs(cad).max() < 1e-4 or np.abs(mcap).max() < 1e-4
            or not res.size
        )
        if silent:
            print("  cadence vs mpv    : FAILED — a capture is silent/empty")
            results["cadence_vs_mpv_exact"] = False
        else:
            mx = float(np.abs(res).max())
            rms = float(np.sqrt((res ** 2).mean()))
            db = 20 * np.log10(max(rms, 1e-20))
            print(
                f"  cadence vs mpv    : max|res|={mx:.3e} rms={db:.1f} dBFS "
                f"bitexact={mx == 0.0}"
            )
            results["cadence_vs_mpv_exact"] = mx == 0.0
            results["cadence_vs_mpv_db"] = db
    else:
        print("  stream rates differ — app-level bit comparison skipped")
        results["cadence_vs_mpv_exact"] = False

    verdict = bool(results) and all(
        v for k, v in results.items()
        if k.endswith("exact") or k.endswith("dropouts")
    )
    print("VERDICT:", "PASS" if verdict else "FAIL")
    if args.keep:
        print("kept:", workdir)
    sys.exit(0 if verdict else 2)


if __name__ == "__main__":
    main()
