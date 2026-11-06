#!/usr/bin/env python3
"""Device-path null test for Cadence issue #1.

Captures what an app ACTUALLY hands PipeWire: we tap the app's playback
stream output ports with `pw-cat -r` (unlinked capture stream, then manual
pw-link fan-out), so the recorded samples are the exact stream buffers —
no sink conversion, no mixer.

Per file:
  1. ffmpeg reference decode -> f32le
  2. cadence-audio plays the file on the REAL default device (CPAL/ALSA ->
     pipewire); we record its stream ports
  3. mpv --ao=pipewire plays the same file; we record its stream ports
  4. null-test: cadence vs mpv, cadence vs ffmpeg, mpv vs ffmpeg
     + zero-run (dropout) and stream format/rate/volume report

Usage:
  device_null_test.py --bin target/debug/cadence-audio <audio-file> [--keep]
"""

import argparse
import json
import os
import re
import signal
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


def drive_cadence(binary, path, generation=1):
    """Start cadence-audio (real device) and play `path`. Returns (proc, events-list-ref)."""
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

    req(
        "audio.load",
        {
            "queueId": "q1",
            "generationId": generation,
            "source": {"kind": "file", "path": str(path)},
        },
        1,
    )
    req("audio.play", {"generationId": generation}, 2)
    return proc, req


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
        for e in self.events:
            if e.get("method") == "event.output":
                return e["params"]
        return None

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


def xcorr_align(cap, seg):
    """Offset where `seg` best matches inside `cap`."""
    if len(cap) < len(seg):
        seg = seg[: len(cap)]
    cc = np.correlate(cap, seg, "valid")
    return int(np.argmax(np.abs(cc)))


def zero_runs(body, ch, min_frames=8):
    """Count runs of consecutive zero frames inside the aligned body —
    mid-signal zero runs are dropouts (underrun / try_lock zero-fill)."""
    frames = body[: len(body) - (len(body) % ch)].reshape(-1, ch)
    z = np.all(frames == 0.0, axis=1)
    runs, cur = [], 0
    for v in z:
        cur = cur + 1 if v else 0
        if not v and cur:
            runs.append(cur)
            cur = 0
    if cur:
        runs.append(cur)
    return [r for r in runs if r >= min_frames]


def compare(name, cap, ref, ch, label):
    """Null-test cap (raw f32 capture) against ref (f32): align a 0.45s
    midsection of ref inside cap by cross-correlation (the recorder
    attaches mid-playback — the file head may not be in the capture),
    subtract, and report the residual."""
    seg = ref[len(ref) // 4 : len(ref) // 4 + min(40000, len(ref) // 2)]
    if len(cap) < len(seg):
        print(f"  {label}: capture too short ({len(cap)//ch} frames)")
        return False, np.array([1.0])
    k = xcorr_align(cap, seg)
    res = cap[k : k + len(seg)] - seg
    mx = float(np.abs(res).max())
    rms = float(np.sqrt((res ** 2).mean()))
    db = 20 * np.log10(max(rms, 1e-20))
    zr = zero_runs(cap[k : k + len(seg)], ch)
    print(
        f"  {label}: max|res|={mx:.3e} rms={db:.1f} dBFS "
        f"bitexact={mx == 0.0} zero-runs(>=8f)={len(zr)}"
        + (f" sizes={zr[:8]}" if zr else "")
    )
    return mx == 0.0, res


def null_residual(a, b):
    """Cross-correlate a short segment of `a` inside `b`, subtract, return
    the residual — robust to different leading silence in each capture."""
    seg = a[40000 : 40000 + 20000] if len(a) > 60000 else a[: len(a) // 2]
    if len(seg) < 1000:
        seg = a
    cc = np.correlate(b, seg, "valid")
    k = int(np.argmax(np.abs(cc)))
    return b[k : k + len(seg)] - seg


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


def unlink_port(port_id):
    """Disconnect every link touching `port_id`."""
    pairs = linked_pairs()
    for o, i in pairs:
        if o == port_id or i == port_id:
            subprocess.run(
                ["pw-link", "-d", str(o), str(i)], capture_output=True
            )


def capture_app_stream(pid, duration_s, workdir, tag, tap, expect_rate):
    """Record `tap`'s monitor while `pid` plays into it (the tap is the
    session default sink, so the app links to it as its driver — a
    rate-matched driver, no resampling between the app and the tap).
    Returns (path, rate, fmt, node_id, props)."""
    sink_id, monitor = tap
    node_id, app_out, props = find_stream(pid, "Stream/Output/Audio")
    rate, fmt = stream_format(node_id, props)
    rec_path = os.path.join(workdir, f"cap-{tag}.f32le")
    rec = Recorder(rec_path, rate or expect_rate, 2)
    rec_in = rec.input_ports()
    for attempt in range(8):
        try:
            rec.tap(monitor, rec_in)
            break
        except subprocess.CalledProcessError:
            if attempt == 7:
                raise
            monitor = node_ports(sink_id, "output")
            time.sleep(0.5)
    time.sleep(duration_s)
    rec.stop()
    return rec_path, rate, fmt, node_id, props


def make_default_sink(name, rate, channels):
    """Create the tap and make it the session default — the app under test
    autoconnects to it as its driver (matched-rate, no rate-matching).
    Returns (module_id, sink_id, monitor_ports, previous_default)."""
    prev = subprocess.run(
        ["pactl", "get-default-sink"], capture_output=True, text=True
    ).stdout.strip()
    mod_id, sink_id = make_null_sink(name, rate, channels)
    subprocess.run(["pactl", "set-default-sink", name], check=True)
    for _ in range(20):
        mon = node_ports(sink_id, "output")
        if len(mon) >= channels:
            return mod_id, sink_id, mon, prev
        time.sleep(0.25)
    unload_module(mod_id)
    raise TimeoutError("null sink monitor ports never appeared")


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
    # passthrough (verified bit-exact), each app links to it as its only
    # driver, and both captures ride the same clock (a directly
    # null-able A/B).
    mod_id, sink_id, monitor, prev_sink = make_default_sink(
        "cadence-tap", src_rate, 2
    )
    tap = (sink_id, monitor)
    subprocess.run(
        ["pw-metadata", "-n", "settings", "0", "clock.force-rate", str(src_rate)],
        capture_output=True,
    )

    # ---- cadence ----
    print("[cadence] starting playback into tap")
    cap_proc, _req = drive_cadence(args.bin, src)
    evr = EventReader(cap_proc)
    try:
        try:
            cap_path, cad_rate, cad_fmt, cad_node, _ = capture_app_stream(
                cap_proc.pid, dur + 0.8, workdir, "cadence", tap, src_rate
            )
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
        # apps deliver at the same rate into the same driver.
        print("[mpv] starting playback into tap")
        mpv = subprocess.Popen(
            [
                args.mpv_bin, "--ao=pipewire", "--no-video", "--really-quiet",
                f"--audio-samplerate={src_rate}", str(src),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        mpv_path, mpv_rate, mpv_fmt, mpv_node, _ = capture_app_stream(
            mpv.pid, dur + 0.8, workdir, "mpv", tap, src_rate
        )
        mpv.wait(timeout=10)
        print(f"[mpv] node={mpv_node} stream={mpv_fmt}@{mpv_rate}")
    finally:
        subprocess.run(
            ["pw-metadata", "-n", "settings", "0", "clock.force-rate", "0"],
            capture_output=True,
        )
        subprocess.run(["pactl", "set-default-sink", prev_sink],
                       capture_output=True)
        unload_module(mod_id)

    # ---- compare ----
    ch = 2
    cad = read_f32(cap_path)
    mcap = read_f32(mpv_path)

    same_rate = cad_rate == mpv_rate == src_rate
    print(f"[compare] rates: source={src_rate} cadence={cad_rate} mpv={mpv_rate}")

    results = {}
    if same_rate:
        ok_c, _ = compare("cadence", cad, ref, ch, "cadence vs ffmpeg")
        ok_m, _ = compare("mpv", mcap, ref, ch, "mpv     vs ffmpeg")
        # The app-level bar: the captured streams must null against each
        # other — i.e. cadence's delivered PCM is indistinguishable from
        # mpv's. Align by cross-correlation; resampler-rate drift between
        # independent captures is bounded to each app's own window.
        res = null_residual(cad, mcap)
        if res.size:
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

    verdict = all(v for k, v in results.items() if k.endswith("exact"))
    print("VERDICT:", "PASS" if verdict else "FAIL")
    if args.keep:
        print("kept:", workdir)
    sys.exit(0 if verdict else 2)


if __name__ == "__main__":
    main()
