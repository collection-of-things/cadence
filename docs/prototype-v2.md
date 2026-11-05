# Cadence — music player prototype, v2 report

Continuation of `docs/prototype-v1.md`. Same stack — Electron shell, React/TypeScript UI, Rust audio service — but the headline changed: **the app must look as good as Cider**, judged from real headless screenshots against Cider reference shots, plus keep driving down the v1 engineering issues.

Report head: `main` @ v2 close, commit TBD.

## What v2 added

**Visual system**
- Design plan: `docs/design/v2-plan.md` (Sol) — tokens, radii, spacing, motion spec, worker ownership map.
- Global tokens in `styles.css`: near-black base, film grain (`--grain-opacity`), radius/shadow/spacing scales, fixed coral accent `#ff7a59` (chrome keeps one identity; the artwork palette feeds the atmosphere, not the UI).
- Shell: left sidebar (search pill, collapsible sections, active pill row, icon rail under 1000px), top bar (back/forward, queue, settings — no duplicated nav), segmented model per the plan.
- Home: horizontal shelves of large rounded cards, real genre shelf derived from track metadata, disabled arrows at edges, per-card scroll, rail edge fade, player clearance.
- Album detail: artwork-wash background, big rounded artwork, metadata chips, circular shuffle + accent Play pill + add.
- Floating player bar: frosted translucent, artwork + title/artist, single transport (accent play, shuffle/repeat, seek with times), expanding volume lane (mute button below 1020px), queue toggle, lyrics toggle.
- Full-screen now playing: saturated artwork-coloured wash (CSS fallback when GPU is off + PixiJS fbm shader on top), artwork left, frosted lyrics card with synced LRC — bright active line, progressive blur by distance, click-to-seek, `offset:` support, scroll-pause + Follow button, instant first snap, resize recentering — and a floating pill with seek, transport, mute, queue.
- Queue: frosted floating panel, portaled to `document.body` so it renders above the immersive overlay; folded into the overlay's Tab cycle.
- Controls/controls.css: pill transport, consistent 1.5px icon set, Sources route cards, toasts (z-1100, above the overlay).

**Data + engine (v1 residuals closed)**
- Lyrics end-to-end: embedded tags + `.lrc` sidecars → `track.lyrics` (protocol), scanner, DB column + migration, row mapping, mock LRC for headless use.
- FFT honesty fix: engine emits dBFS (−100..0); mock now emits the same units, shader normalizes dB→0..1 — the real route was silently broken before.
- `advance_track` parks ended readers for the monitor thread (no free on the audio callback); `FfmpegDecoder` reuses the plan's probe (kills repeat ffprobe runs); explicit feed errors; `audio.clearPrefetch` covered by test.

## How we verify visuals

`apps/desktop/scripts/capture.cjs` + `scripts/screenshot.sh` — offscreen `BrowserWindow` under Electron 45, `webContents.capturePage` → PNG. Runs on the real display with x11 ozone (`disable-gpu`, unique `userData` per run) or Xvfb fallback. Mock API via `?cadence_mock=1`; state driven through `window.__cadenceSession`. No Chrome/Playwright, no visible windows.

## Council scores (per round, every seat ran the app headlessly)

| Round | Sol (visual+product) | Terra (visual design) | Astra (skeptical eng.) | SWE-2 (eng+UX) |
|---|---|---|---|---|
| R1 | 6.0 | 5.0 | 5.0 | 7.0 |
| R2 | 7.5 | 6.0 | 6.5 | 7.0 |
| R3 | — | — | — | — |

Seats/models: Sol = GPT-6.1 Sol (codex R1, acpRegistry `gpt-6-sol-medium` after quota), Terra = GPT-6.1 Terra, Astra = GPT-6 Astra (substitute for DeepSeek V4.1 Flash — opencode delegation failed on missing forward secret every attempt), SWE-2 = swe-2-high delegate. Rules per round: run the app headlessly, judge own captures vs `docs/design/cider-ref/*.webp`, cite screenshots, invalid if the app can't run. No target scores revealed.

## Verified

- ~45 ranked council findings fixed across R1+R2, each re-verified by screenshot where visual.
- Headless captures at 1440×900 and small windows committed under `docs/design/screens/`.
- 38 desktop + 29 UI tests, 37 Rust tests, 0 TS errors (verify last run: TBD).
- Queue-over-overlay, lyrics seek/follow, focus containment, keyboard flows — live DOM-checked.

## Not verified

- Real audio path unchanged from v1 — PCM decode/gapless verified headlessly (mock drives visuals only); WebGL2 shader on a real GPU untested (captures use software raster).
- Provider sign-in/playback, DRM signing, hardware device loss, Windows/macOS — same as v1.
- Motion quality, hover micro-interactions, lyric scroll smoothness — static captures can't judge.
- Photographic artwork palette extraction (mock uses synthetic SVGs).

## Remaining issues

- Playlists/pins/favorites: no API — nav sections honestly absent rather than stubbed.
- Readable-lyrics (unsynced) mode unstyled vs synced.
- `audio.feed` head-of-line on the RPC loop (v1 inherent).
- 600ms promotion heuristic, exclusive output, MPRIS, provider queue mirroring — unchanged from v1.

## Run it

```bash
cd ~/dev/work/music-player && pnpm install
cargo build --manifest-path services/audio/Cargo.toml && pnpm -r build
pnpm --filter @cadence/desktop start          # real app
pnpm --filter @cadence/ui build
bash scripts/screenshot.sh shot "" 3000        # headless capture → docs/design/screens/
```
