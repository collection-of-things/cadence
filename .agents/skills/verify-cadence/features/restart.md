# restart: quit mid-track, restore paused

Run: `.agents/skills/verify-cadence/helpers/cadence-verify run restart`

Plays Beacon ~4s, quits gracefully (windows destroyed, `app.quit()` →
will-quit → persistNow), relaunches with the same user-data dir, then
checks ordered queue track identities, currentIndex, the restored track,
and meaningful persisted/restored positions. Persisted position must be
within 2.5s of the quit snapshot; restored position must be nonzero and
within 2s of persisted state. It requires **paused** status, no stray
stream, graceful quit, and resume on the restored track with advancing
position and a stream routed to the tap. Transport Play is tried first,
with bridge resume as the documented fallback.

The helper works around a close-handler trap: `win.on('close')` can trap programmatic
`app.quit()` forever. The harness destroys windows first and records
`quit mode=graceful|killed`; a killed quit fails the restore contract.
After restore the flow resumes with the transport Play button and falls
back to the bridge `resume`; a fallback is recorded as a NOTE.

Negative control: `.agents/skills/verify-cadence/helpers/cadence-verify run restart --break no-restore` deletes
only this run's persisted settings before relaunch and must FAIL.
Use `run restart`; the flow needs a managed Electron lifecycle handle.

Track-length note: the fixture tracks are short. The flow's play+screenshot+quit
sequence spans a few seconds of that, so a quit that runs long can race
natural end-of-track: another reason `quit mode` belongs in evidence.

The restore observations are non-gating individually, then a required aggregate
check requires all of them to hold. A fallback transport NOTE is separate. Resume
checks the restored track and advancing position, but does not compare resumed
position with the persisted point or capture PCM. Use audio for capture proof.

Evidence: `evidence/before-quit.png`, `evidence/after-relaunch.png`, `evidence/resumed.png`,
`state/restored.json`, `state/cadence-settings-after-quit.json`.

For setup, isolation, evidence interpretation and completion criteria, return to
[Verify Cadence](../SKILL.md).
