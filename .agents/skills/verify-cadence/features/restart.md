# restart — quit mid-track, restore paused

Run: `cadence-verify run restart`

Plays Beacon ~4s, quits gracefully (windows destroyed, `app.quit()` →
will-quit → persistNow), relaunches with the same user-data dir, then
checks the contract: same queue size, same track, position within 4s of
quit point, status **paused** (never autoplay), no stray audio stream
while paused, resume works (transport first, bridge fallback).

Relevant defects on main: the app's `win.on('close')` traps programmatic
`app.quit()` forever — the harness destroys windows first and records
`quit mode=graceful|killed` so a killed quit (which lets the track end
inside the fallback window and contaminates persisted state) is visible
in the transcript, not hidden. Separately: after restore, the transport
Play click is inert — only the bridge `resume` starts playback; the flow
records it as a NOTE.

The position check compares the restored position against the last
*snapshot* before quit (the persisted file can drift a few hundred ms
behind it — that's expected, not a defect).

Track-length note: fixtures are 14–16s. The flow's play+screenshot+quit
sequence spans a few seconds of that, so a quit that runs long can race
natural end-of-track — another reason `quit mode` belongs in evidence.

The gate is evidence-first — every observation lands in the transcript
before the contract check fires.

Evidence: `before-quit.png`, `after-relaunch.png`, `resumed.png`,
`state/restored.json`, `state/cadence-settings-after-quit.json`.
