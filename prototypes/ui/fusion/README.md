# Cadence — fusion UI prototype

One file, `index.html` — vanilla HTML/CSS/JS, no build. Open it in any browser.
Covers are inlined as data URIs; Google Fonts (Inter) is the only network fetch.

## Concept

Cadence acts as a beautiful client for **one streaming platform at a time** — Apple
Music, Spotify, or YouTube Music. A platform switcher (sidebar account card, or the
PLATFORM section) swaps the entire app — Home, Browse, Radio, Library, playlists,
mixes and Now Playing — to that service, with a short swap transition. Each platform
carries a subtle identity cue (service chip + a colored edge on the active row)
without restyling the whole shell.

Local files (`~/Music`) are the exception: always available alongside the active
platform under their own FILES group as "On this Mac" — first-class, with full
format and quality display (FLAC 24/96, FLAC 16/44.1), but secondary in the framing.
One platform starts unconnected; choosing it runs Connect → Syncing → switched.
Switching also re-validates playback: a track absent from the new platform's
library swaps Now Playing to that platform's album, and the queue/history are
pruned to what the active platform can play.

The design fuses the three earlier directions: a Cider-faithful dark glass shell
(Aurora), spring-driven sheets and dock (Liquid Glass), and a WebGL cover-sampled
ambient backdrop with karaoke lyrics (Canvas). Inter variable font with optical
sizing; motion is transform/opacity only.

## Try

- Click the account card or a PLATFORM row to open the switcher; try "Connect" on
  the unconnected service.
- `⌘K` palette, `L` lyrics, `Q` queue, `N` now playing, `Space` play/pause,
  arrows seek/volume, `H` library. Right-click anything. Drag to reorder the queue.
- Click a lyric line to seek.

## Council scores (final)

| Seat | Model | R1 | R2 | R3 |
|------|-------|----|----|----|
| Terra | codex `gpt-6.1-terra` (high) | 7 | 8 | **8.5** |
| SWE-2 | `swe-2-high` subagent | 7 | 7.5 | **8** |
| Seat 3 | `swe-2-flash-medium` | — | 6 | **7.5** |

DeepSeek V4.1 Flash was the intended third seat but could not run in this
environment ("missing forward secret" on both attempts), and a standing model rule
limits Devin-side seats to SWE-2 / SWE-2 Flash / Fusion-with-SWE-2. Seat 3 was
substituted with `swe-2-flash-medium`.

## Last critiques

- **Terra (8.5)**: "A distinctive, convincing music player with a few
  compact-screen and legibility details still holding it back." Remaining fixables:
  keep On this Mac above the 1280×800 sidebar fold, clearer queue bottom boundary,
  readability of the smallest playback labels and resting lyrics.
- **SWE-2 (8)**: "A polished, coherent dark client whose last mile is data-shaped."
  Remaining fixables: sparse sections at 1440, some mid-value truncation,
  cross-mosaic cover reuse, uniform format columns, NP seek anchoring — all since
  addressed where fixable.
- **Seat 3 (7.5, code-reviewed)**: "The craft is now where a 7.5 should be — the
  remaining gap to 10 is stale state on platform switch, not visual defects." Its
  palette-staleness, lyrics-desync and accent-contrast fixes are all landed.

## Named residual blockers

- Connect → Syncing is a timed stand-in; the real OAuth handshake can't be shown.
- Hover-affordances, motion quality, palette fade and lyrics timing are not
  provable from stills.
- Only 8 bundled covers exist, so art repeats across shelves — a data limit, not
  a layout one.
