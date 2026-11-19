# playback: transport as a user works it

Run: `.agents/skills/verify-cadence/helpers/cadence-verify run playback`

Row-click play, position advances, transport pause/resume, spacebar
toggle (blur first: a focused row swallows Space), seek-bar click at
65%, Next/Previous (waits for the title to change), "Play next" queueing
from Field Notes (row "More actions" menu), queue-panel row jump, queue
remove via bridge.

Next expects Meridian; Previous expects Beacon. Historical transition races
can affect these checks; inspect current state and transcript before assigning
the failure to the product. Removal runs only when items remain after the current
one. This flow checks transport state, not captured PCM or resume-position
preservation; use the audio flow for those observations.

Evidence: `evidence/queue-before-jump.png`, `state/after-seek.json`,
`state/queue-final.json`.

For setup, isolation, evidence interpretation and completion criteria, return to
[Verify Cadence](../SKILL.md).
