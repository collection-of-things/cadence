# smoke: the CI subset

Start here for local app proof. Duration depends on build and private-core startup. Run:
`.agents/skills/verify-cadence/helpers/cadence-verify run smoke`

Checks: launch + `window.cadence` bridge, 5 fixture tracks indexed after
`library.scan`, Library nav, Signal Atlas album open, Beacon click-to-play,
app stream routed into `cadence_verify` (pw-dump link assertion), a short
sink-monitor capture with at least 1.5s audible PCM, and pause.

Evidence: `evidence/01-*.png` through `evidence/05-*.png`, `state/library-tracks.json`,
`state/pw-stream.json`, `evidence/transcript.jsonl`.

This is the account-free flow `scripts/verify.sh` attempts when its system-tool
gate passes. That script can skip Electron smoke and still report PASS; inspect
the SKIP output before claiming end-to-end coverage.

Negative control: `.agents/skills/verify-cadence/helpers/cadence-verify run smoke --break mute` must FAIL.

For setup, isolation, evidence interpretation and completion criteria, return to
[Verify Cadence](../SKILL.md).
