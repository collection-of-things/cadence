#!/usr/bin/env python3
"""Analyze a PipeWire monitor capture (raw f32le) against a reference track.

Proves "real audio came out" on the graph, not on the app's say-so:
  - not silent: non-zero RMS, non-silent span of the expected duration
  - right level: captured RMS within tolerance of the ffmpeg-decoded source
  - seek moved it: split the capture into labeled segments; each segment
    cross-correlates against the decoded reference at one unambiguous
    offset, and the offset after a seek must jump forward by ~the seek delta.

Alignment uses the same FFT cross-correlation approach as
scripts/device_null_test.py (issue-1 harness): chirp fixtures make each
instant unique, so one argmax per segment is trustworthy.

Usage:
  analyze_audio.py CAPTURE.f32le --ref TRACK.flac --rate 48000 --channels 2 \
      --min-audible-s 3.0 --rms-tolerance 3.0 \
      [--seek-point-s 4.5 --seek-delta-s 5.0] [--out analysis.json]
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np


def read_f32(path):
    return np.fromfile(path, dtype="<f4")


def ffmpeg_ref(path, rate, channels):
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le",
         "-ar", str(rate), "-ac", str(channels), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(out, dtype="<f4")


def mixdown(x, ch):
    if ch <= 1:
        return x
    return x.reshape(-1, ch).mean(axis=1)


def xcorr_offset(cap, seg):
    """Offset in `cap` where `seg` best aligns (FFT cross-correlation)."""
    if len(cap) < len(seg):
        return None, 0.0
    n = len(cap) + len(seg) - 1
    nfft = 1 << (n - 1).bit_length()
    cc = np.fft.irfft(np.fft.rfft(cap, nfft) * np.fft.rfft(seg[::-1], nfft), nfft)
    valid = cc[len(seg) - 1: len(seg) - 1 + len(cap) - len(seg) + 1]
    k = int(np.argmax(np.abs(valid)))
    seg_n = float(np.sqrt((seg ** 2).mean()))
    cap_win = cap[k:k + len(seg)]
    if len(cap_win) < len(seg):
        return k, 0.0
    cap_n = float(np.sqrt((cap_win ** 2).mean()))
    denom = seg_n * cap_n
    score = float(abs(valid[k])) / (len(seg) * denom) if denom > 0 else 0.0
    return k, score


def rms_dbfs(x):
    r = float(np.sqrt((x ** 2).mean())) if len(x) else 0.0
    return 20 * np.log10(max(r, 1e-20))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("capture")
    ap.add_argument("--ref", required=True)
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--channels", type=int, default=2)
    ap.add_argument("--min-audible-s", type=float, default=2.0,
                    help="minimum seconds of non-silent audio expected")
    ap.add_argument("--silence-dbfs", type=float, default=-60.0)
    ap.add_argument("--rms-tolerance", type=float, default=6.0,
                    help="max |dB| difference between capture and reference bodies")
    ap.add_argument("--seek-point-s", type=float, default=None,
                    help="capture time (s) where a seek was issued")
    ap.add_argument("--seek-delta-s", type=float, default=None,
                    help="deliberate forward jump (s) issued at seek-point")
    ap.add_argument("--pause-point-s", type=float, default=None,
                    help="capture time (s) where a pause was issued — the following ~1.2s must be silent")
    ap.add_argument("--seek-tolerance-s", type=float, default=0.75,
                    help="allowed error around the expected source jump")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    rate, ch = args.rate, args.channels

    result = {"capture": args.capture, "ref": args.ref, "rate": rate,
              "checks": [], "ok": True}

    def check(name, ok, detail=""):
        result["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            result["ok"] = False
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")

    def finish():
        if args.out:
            with open(args.out, "w") as f:
                json.dump(result, f, indent=2)
        sys.exit(0 if result["ok"] else 1)

    # --- input validity: reject empty/truncated/misaligned/non-finite PCM ----
    # A capture that fails here is a broken pipeline, not analyzable audio.
    # Check the FILE's byte size — np.fromfile silently drops a partial
    # trailing element, so len(raw)*4 cannot be trusted for alignment.
    try:
        file_bytes = os.path.getsize(args.capture)
        raw = read_f32(args.capture)
    except (OSError, ValueError) as e:
        check("capture input valid", False, f"cannot read capture: {e}")
        finish()
    frame_bytes = 4 * ch
    if file_bytes == 0:
        check("capture input valid", False, "capture file is empty")
        finish()
    if file_bytes % 4 != 0:
        check("capture input valid", False,
              f"{file_bytes} bytes is not a multiple of 4 (f32 samples) — truncated write")
        finish()
    if file_bytes % frame_bytes != 0:
        check("capture input valid", False,
              f"{file_bytes} bytes is not a whole number of {ch}-ch f32 frames — truncated write")
        finish()
    cap = mixdown(raw, ch)
    if len(cap) < int(rate * 0.5):
        check("capture input valid", False,
              f"only {len(cap) / rate:.2f}s of audio — too short to analyze")
        finish()
    if not np.isfinite(cap).all():
        check("capture input valid", False, "capture contains NaN/Inf samples")
        finish()
    try:
        ref = mixdown(ffmpeg_ref(args.ref, rate, 1), 1)
    except (subprocess.CalledProcessError, OSError) as e:
        check("reference decodes", False, f"ffmpeg failed on ref: {e}")
        finish()
    if len(ref) == 0 or not np.isfinite(ref).all():
        check("reference decodes", False, "reference decoded empty or non-finite")
        finish()
    check("capture input valid", True, f"{len(cap) / rate:.2f}s f32le@{rate}Hz")

    # --- not silent ---------------------------------------------------------
    frame = int(rate * 0.05)  # 50ms windows
    win_rms = np.array([rms_dbfs(cap[i:i + frame]) for i in range(0, len(cap) - frame + 1, frame)])
    audible = win_rms > args.silence_dbfs
    audible_s = float(audible.sum() * frame / rate)
    result["audible_seconds"] = audible_s
    check("capture not silent", audible_s >= args.min_audible_s,
          f"{audible_s:.2f}s audible (>= {args.min_audible_s}s expected)")

    # --- level right ---------------------------------------------------------
    nz = np.flatnonzero(audible)
    level_detail = ""
    if len(nz):
        body = cap[nz[0] * frame:(nz[-1] + 1) * frame]
        c_db, r_db = rms_dbfs(body), rms_dbfs(ref[: len(body)])
        diff = abs(c_db - r_db)
        level_detail = f"capture {c_db:.1f} dBFS vs reference {r_db:.1f} dBFS"
        check("output level sane", diff <= args.rms_tolerance,
              f"{level_detail} (|Δ| {diff:.1f} dB <= {args.rms_tolerance})")
        result["capture_dbfs"] = c_db
        result["reference_dbfs"] = r_db

    # --- pause silences the tap -----------------------------------------------
    if args.pause_point_s is not None:
        a = int((args.pause_point_s + 0.45) * rate)
        b = int((args.pause_point_s + 1.45) * rate)
        hole = cap[a:b]
        # the WHOLE window must be present — a capture that ends early
        # proves nothing about what followed the pause
        if len(hole) < b - a:
            check("pause silences output", False,
                  f"capture ends inside the pause window ({len(hole) / rate:.2f}s of {1.0:.2f}s required)")

        else:
            hole_db = rms_dbfs(hole)
            result["pause_dbfs"] = hole_db
            # near-silence OR ≥15 dB below the playing body — handles a
            # fade-out tail and tracks that end quietly
            body_db = result.get("capture_dbfs", 0.0)
            quiet = hole_db <= args.silence_dbfs or hole_db <= body_db - 15.0
            check("pause silences output", quiet,
                  f"pause window {hole_db:.1f} dBFS (silence {args.silence_dbfs} or body-15={body_db - 15.0:.1f})")

    # --- seek moved it --------------------------------------------------------
    if args.seek_point_s is not None and args.seek_delta_s is not None:
        seg_s = 1.5
        # pre segment ends at the seek point; post starts 0.3s after it.
        # Between the two window CENTERS, source time advances by playback
        # for (seg_s + 0.3)s of wall time PLUS the deliberate delta — the
        # expected jump must account for the elapsed capture time between
        # the sampled windows, not just the seek delta.
        pre_start = args.seek_point_s - seg_s
        post_start = args.seek_point_s + 0.3
        if pre_start < 0:
            check("seek moved output", False,
                  f"seek point {args.seek_point_s}s leaves no {seg_s}s pre window")
            finish()
        pre = cap[int(pre_start * rate): int(args.seek_point_s * rate)]
        post = cap[int(post_start * rate): int((post_start + seg_s) * rate)]
        if len(pre) < int(seg_s * rate) or len(post) < int(seg_s * rate):
            check("seek moved output", False,
                  "capture ends inside a seek window — not enough runway")
            finish()
        # locate both segments inside the REFERENCE (source position)
        k_ref_pre, sc_pre = xcorr_offset(ref, pre)
        k_ref_post, sc_post = xcorr_offset(ref, post)
        if k_ref_pre is None or k_ref_post is None:
            check("seek moved output", False, "segment too short to align")
        else:
            src_pre = (k_ref_pre + len(pre) / 2) / rate
            src_post = (k_ref_post + len(post) / 2) / rate
            jump = src_post - src_pre
            # wall time between window centers + deliberate delta
            elapsed_between_windows = (post_start + seg_s / 2) - (pre_start + seg_s / 2)
            expected = args.seek_delta_s + elapsed_between_windows
            result["seek"] = {
                "pre_source_s": src_pre, "post_source_s": src_post,
                "jump_s": jump, "expected_s": expected,
                "seek_delta_s": args.seek_delta_s,
                "elapsed_between_windows_s": elapsed_between_windows,
                "score_pre": sc_pre, "score_post": sc_post,
            }
            aligned = sc_pre > 0.25 and sc_post > 0.25
            check("segments align to reference", aligned,
                  f"corr {sc_pre:.2f}/{sc_post:.2f}")
            check("seek moved output",
                  aligned and abs(jump - expected) <= args.seek_tolerance_s,
                  f"source position jumped {jump:.2f}s at seek "
                  f"(expected {expected:.2f}s = delta {args.seek_delta_s} + {elapsed_between_windows:.2f}s elapsed, "
                  f"tol ±{args.seek_tolerance_s}s)")

    finish()


if __name__ == "__main__":
    main()
