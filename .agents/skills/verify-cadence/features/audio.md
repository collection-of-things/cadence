# audio — prove real PCM leaves the app

Run: `cadence-verify run audio`

Records the `cadence_verify` monitor ports while the app plays Vantage,
seeks +4s, and pauses, then `analyze_audio.py` compares the capture to the
decoded fixture:

- complete, finite stereo PCM and capture not silent (>= 6s audible)
- level within 6 dB of reference
- pause window goes silent (or >=15 dB below the playing body)
- pre/post-seek segments cross-correlate with the reference (score > 0.25,
  observed ~1.0)
- source position jumped by the 4s seek plus elapsed time between windows
  (tolerance 0.75s)

Also probes resume-after-pause as a non-fatal NOTE — on main, resume
restarts queue[0]@0 (documented product defect, see SKILL.md).

Evidence: `audio/monitor-capture.f32le|.wav`, `audio/analysis-*.json`.

Negative control: `cadence-verify run audio --break mute` must FAIL.
