# restart — quit mid-track, restore paused

Run: `cadence-verify run restart`

Plays Beacon ~4s, quits gracefully (windows destroyed, `app.quit()` →
will-quit → persistNow), relaunches with the same user-data dir, then
checks ordered queue track identities, currentIndex, the restored track,
and meaningful persisted/restored positions. Persisted position must be
within 2.5s of the quit snapshot; restored position must be nonzero and
within 2s of persisted state. It requires **paused** status, no stray
stream, graceful quit, and resume on the restored track with advancing
position and a stream routed to the tap. Transport Play is tried first,
with bridge resume as the documented fallback.

Relevant defects on main: the app's `win.on('close')` traps programmatic
`app.quit()` forever — the harness destroys windows first and records
`quit mode=graceful|killed`; a killed quit fails the restore contract.
After restore the flow resumes with the transport Play button and falls
back to the bridge `resume`; a fallback is recorded as a NOTE.

Negative control: `cadence-verify run restart --break no-restore` deletes
only this run's persisted settings before relaunch and must FAIL.
Use `run restart`; the flow needs a managed Electron lifecycle handle.

Track-length note: fixtures are 14–16s. The flow's play+screenshot+quit
sequence spans a few seconds of that, so a quit that runs long can race
natural end-of-track — another reason `quit mode` belongs in evidence.

The gate is evidence-first — every observation lands in the transcript
before the contract check fires.

Evidence: `before-quit.png`, `after-relaunch.png`, `resumed.png`,
`state/restored.json`, `state/cadence-settings-after-quit.json`.
