# smoke — the CI subset

Fastest proof the app is alive end to end (~60s). Run:
`cadence-verify run smoke`

Checks: launch + `window.cadence` bridge, 5 fixture tracks indexed after
`library.scan`, Library nav, Signal Atlas album open, Beacon click-to-play,
app stream routed into `cadence_verify` (pw-dump link assertion), pause.

Evidence: `evidence/01-*.png..05-*.png`, `state/library-tracks.json`,
`state/pw-stream.json`, `evidence/transcript.jsonl`.

This is the flow `scripts/verify.sh` runs in CI: headless, local files,
no accounts.
