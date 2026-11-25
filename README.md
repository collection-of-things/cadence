# Evidence for the UI polish PR (t3/polish-app-ui)

Screenshots and videos for every stage of the council-reviewed UI pass. This
branch only holds evidence; it is never merged and can be deleted after review.

| Stage | Commit | Council (GPT 6.2 Sol · Gemini 4 Neon · Opus 5.5) | Gallery | Walkthrough | Quarter-speed motion |
| --- | --- | --- | --- | --- | --- |
| Before | main @ e671201 | rated 5.7–6.0 · 5.5 · 5 | [r0-before.md](r0-before.md) | [mp4](r0-before/walkthrough.mp4) | [mp4](r0-before/motion-quarter-speed.mp4) |
| Round 1 | e2b9b21 | 7.2 · 7.0 · 6.5 | [r1.md](r1.md) | [mp4](r1/walkthrough.mp4) | [mp4](r1/motion-quarter-speed.mp4) |
| Round 2 | ce72006 | 8.1 · 8.3 · 7.3 | [r2.md](r2.md) | [mp4](r2/walkthrough.mp4) | [mp4](r2/motion-quarter-speed.mp4) |
| Round 3 | e9a0bda | 8.7 · 9.0 · 8.2 | [r3.md](r3.md) | [mp4](r3/walkthrough.mp4) | [mp4](r3/motion-quarter-speed.mp4) |
| Round 4 | 28dbff3 | 9.1 · 9.3 · 8.8 | [r4.md](r4.md) | [mp4](r4/walkthrough.mp4) | [mp4](r4/motion-quarter-speed.mp4) |
| Final | 27142f8 | 9.3 · 9.6 · 9.4 | [r5.md](r5.md) | [mp4](r5/walkthrough.mp4) | [mp4](r5/motion-quarter-speed.mp4) |

[compare.md](compare.md) puts every state side by side, before and final.

How it was captured: `harness/` drives the built UI (mock data,
`?cadence_mock=1`, or `?cadence_mock=worst` for the 40–47 worst-case states)
in an invisible Electron window with Playwright; every stage runs the same
44 scripted states at 1440×900 plus narrow and wide windows, a 32 s
walkthrough with a drawn cursor, and the key transitions at quarter speed
(DevTools playback rate 0.25). `audit*.txt` in each stage lists any element
that scrolls sideways (empty = none). The before and round-1 builds had the
worst-case mock fixture patched in so their 40–47 states use the same data.

`council/` holds the Opus seat's written reports; the other seats replied
inline (summarised in the PR).
