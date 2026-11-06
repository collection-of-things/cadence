# audio — prove real PCM leaves the app

Run: `cadence-verify run audio`

Records the `cadence_verify` monitor ports while the app plays Vantage,
seeks +5s, and pauses, then `analyze_audio.py` compares the capture to the
decoded fixture:

- capture not silent (>= 7s audible)
- level within 6 dB of reference
- pause window goes silent (or >=15 dB below the playing body)
- pre/post-seek segments cross-correlate with the reference (score > 0.25,
  observed ~1.0)
- source position jumped ~+5s at seek (tolerance 2.5s)

Also probes resume-after-pause as a non-fatal NOTE — on main, resume
restarts queue[0]@0 (documented product defect, see SKILL.md).

Evidence: `audio/monitor-capture.f32le|.wav`, `audio/analysis.json`.
