# playback — transport as a user works it

Run: `cadence-verify run playback`

Row-click play, position advances, transport pause/resume, spacebar
toggle (blur first — a focused row swallows Space), seek-bar click at
65%, Next/Previous (waits for the title to change), "Play next" queueing
from Field Notes (row "More actions" menu), queue-panel row jump, queue
remove via bridge.

Known flake on main: the previous/next assertions can catch the
coordinator's transition-advance defect mid-flight — the check is strict
on purpose; a red run here is usually the app, not the harness.

Evidence: `queue-before-jump.png`, `state/after-seek.json`,
`state/queue-final.json`.
