#!/usr/bin/env python3
"""Live end-of-track drain test for cadence-audio.

Plays file A into a PipeWire null tap with a recorder pre-attached;
the instant `event.trackEnded` arrives, loads and plays file B on the
SAME stream (same format → the sink-reuse path — the riskiest one:
the drain's flush(true) deactivates the shared stream and the new
track must reactivate it). The capture runs across the whole
transition.

Checks:
- A's content arrives complete AND bit-exact — the drain must not cut
  the tail (the original defect class this whole protocol exists for).
- B's content arrives complete AND bit-exact — the reused stream must
  actually resume processing (a latched `drained` = silent B).
- The inter-track gap is bounded — a stalled drain/deadlock would
  blow the bound.
- No event.error — the watchdog must not false-trip on a drained
  stream.

Needs: a live PipeWire, pw-dump/pw-link/pw-cat/pw-metadata, ffmpeg.
Usage: python3 device_transition_test.py --bin target/debug/cadence-audio A.flac B.flac
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from device_null_test import (
    attach_recorder,
    app_stream_info,
    best_align,
    compare,
    drive_cadence,
    ffmpeg_ref,
    ffprobe_duration,
    ffprobe_rate,
    make_null_sink,
    node_ports,
    read_f32,
    xcorr_valid,
    unload_module,
)


def wait_event(evr, method, timeout):
    """Wait for an event method; return its params or None."""
    deadline = time.time() + timeout
    seen = len(evr.events)
    while time.time() < deadline:
        for e in evr.events[seen:]:
            if e.get("method") == method:
                return e.get("params", {})
        time.sleep(0.02)
    return None


def find_b_start(cap, ref_b):
    """Locate B's content start in the capture: correlate a B
    midsegment over the whole capture (B can't overlap A — same
    stream), anchored on content-start like best_align's callers."""
    seg = ref_b[: min(len(ref_b), 60000)]
    cc = xcorr_valid(cap, seg)
    if len(cc) == 0:
        return -1
    return int(np.argmax(np.abs(cc)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("file_a")
    ap.add_argument("file_b")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    a = Path(args.file_a).resolve()
    b = Path(args.file_b).resolve()
    ref_a, ref_b = ffmpeg_ref(a), ffmpeg_ref(b)
    rate_a, rate_b = ffprobe_rate(a), ffprobe_rate(b)
    dur_a, dur_b = ffprobe_duration(a), ffprobe_duration(b)
    if rate_a != rate_b:
        print(f"rates differ ({rate_a} vs {rate_b}) — the reuse path "
              "under test needs same-format tracks")
        sys.exit(3)
    workdir = tempfile.mkdtemp(prefix="cadence-trans-")
    print(f"A: {a.name} | B: {b.name} ({rate_a} Hz) | workdir {workdir}")

    mod_id, sink_id = make_null_sink("cadence-tap", rate_a, 2)
    monitor = []
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
    prev_force = m.group(1) if m else "0"
    subprocess.run(
        ["pw-metadata", "-n", "settings", "0", "clock.force-rate",
         str(rate_a)],
        capture_output=True,
    )

    cap_proc = None
    results = {}
    try:
        print("[cadence] loading A paused into tap")
        cap_proc, req, evr = drive_cadence(
            args.bin, a, device="cadence-tap", start_paused=True)
        cad_node, cad_rate, cad_fmt, _ = app_stream_info(
            cap_proc.pid, expect_name="cadence-audio")
        rec, cap_path = attach_recorder(
            workdir, "trans", tap, cad_rate or rate_a, tap[0])
        try:
            req("audio.play", {"generationId": 1}, 2)
            # The drain moment: trackEnded must arrive, then B loads
            # INSTANTLY on the same sink.
            ended = wait_event(evr, "event.trackEnded", dur_a + 8)
            if ended is None:
                print("  FAIL: no event.trackEnded — end-of-track "
                      "detection is broken")
                results["track_ended"] = False
                time.sleep(1)
            else:
                results["track_ended"] = True
                t_load = time.time()
                req(
                    "audio.load",
                    {
                        "queueId": "q2",
                        "generationId": 2,
                        "source": {"kind": "file", "path": str(b)},
                    },
                    10,
                )
                req("audio.play", {"generationId": 2}, 11)
                print(f"[transition] trackEnded → load B at +0ms "
                      f"(same sink, same format)")
            time.sleep(dur_b + 0.8)
        finally:
            if rec.proc.poll() is None:
                rec.stop()
        # Assert B's stream: the same node id as A's proves the
        # sink-reuse path this test exists for — a rebuilt node would
        # mean the drain→reuse contract wasn't exercised at all.
        try:
            b_node, _, _, _ = app_stream_info(
                cap_proc.pid, expect_name="cadence-audio")
            results["sink_reused"] = b_node == cad_node
            print(f"[transition] A node={cad_node} B node={b_node} "
                  f"reused={results['sink_reused']}")
        except Exception as e:
            results["sink_reused"] = False
            print(f"  no B stream node: {e}")
        # A failed drain → watchdog trip → event.error. Any error
        # event fails this test.
        errs = [e for e in evr.events
                if e.get("method") == "event.error"]
        results["no_error_events"] = not errs
        for e in errs:
            print("  event.error:", e.get("params"))
        req("audio.shutdown", {}, 99)
        try:
            cap_proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            cap_proc.kill()
    finally:
        if cap_proc is not None and cap_proc.poll() is None:
            cap_proc.kill()
        subprocess.run(
            ["pw-metadata", "-n", "settings", "0", "clock.force-rate",
             prev_force],
            capture_output=True,
        )
        if mod_id:
            unload_module(mod_id)

    # ---- compare ----
    ch = 2
    cap = read_f32(cap_path)
    b_start = find_b_start(cap, ref_b)
    if b_start < 0:
        print("  B never appeared in the capture — the reused stream "
              "never resumed")
        results["b_present"] = False
        a_region = cap
        gap_ms = None
    else:
        results["b_present"] = True
        a_region = cap[:b_start]
        # A's content end = its alignment offset + ref length.
        k_a = best_align(cap, ref_a)
        a_end = k_a + len(ref_a)
        gap_ms = max(0, b_start - a_end) * 1000 / (rate_a * ch)
        print(f"[transition] A end @{a_end} → B start @{b_start} "
              f"gap={gap_ms:.0f} ms")
        # Bounded transition: park + drain + resume must finish well
        # under 2s even on a slow graph.
        results["gap_bounded"] = gap_ms < 2000

    # The recorder was attached before A played — nothing justifies
    # missing content, so the checks demand effectively full coverage
    # (0.999 tolerates a single boundary frame at the stream edge).
    ok_a, _ = compare(
        "cadence", a_region, ref_a, ch, "track A vs ffmpeg", min_cov=0.999)
    ok_b, _ = (
        compare("cadence", cap[b_start:], ref_b, ch, "track B vs ffmpeg",
                min_cov=0.999)
        if b_start >= 0 else (False, 0)
    )
    results["a_tail_intact"] = ok_a
    results["b_head_intact"] = ok_b

    verdict = bool(results) and all(results.values())
    print(results)
    print("VERDICT:", "PASS" if verdict else "FAIL")
    if args.keep:
        print("kept:", workdir)
    sys.exit(0 if verdict else 2)


if __name__ == "__main__":
    main()
