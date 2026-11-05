# Cadence — music player prototype, v2 report

Continuation of `docs/prototype-v1.md`. Same stack — Electron shell, React/TypeScript UI, Rust audio service. The v2 headline: **the app must look as good as Cider**, judged from real headless screenshots against Cider reference shots (`docs/design/cider-ref/*.webp`), while driving down the v1 engineering issues. Hill-climb stopped at the 21:00 IST deadline; no seat reached 9, but every ranked finding from every round was fixed and re-verified on screen before the next round launched.

Report head: `main` @ `bd83c06`.

## What v2 added

**Visual system** (see `docs/design/v2-plan.md` — Sol)
- Global tokens: near-black base, film grain, radius/shadow/spacing scales, fixed coral accent `#ff7a59` (chrome keeps one identity; artwork palette feeds the atmosphere only).
- Shell: left sidebar (search pill, flat 3-row nav, soft accent active state, icon rail <1000px that collapses entirely via the toggle), top bar with history pills and settings — nav lives in one place.
- Home: horizontal shelves, larger lead shelf, real genre shelf derived from track metadata, disabled arrows hidden at edges, per-card scroll, rail edge fade, caption-below cards, player clearance.
- Album detail: artwork-wash background, hero art, ALBUM eyebrow, fact chips, circular shuffle + accent Play pill + add; hairline track rows, artist dedupe, accent "now playing" row with EQ bars.
- Floating player bar: frosted, artwork + title/artist, single transport, seek with times, expanding volume lane (mute below 1020px), queue toggle, lyrics toggle.
- Full-screen now playing: saturated artwork-coloured wash (CSS fallback when GPU is off + PixiJS fbm shader on top), artwork + metadata left, frosted synced-lyrics card — bright crisp active line, symmetric progressive recession (past dimmed+blurred, upcoming d1/d2/d3), click-to-seek, `offset:` support, manual-scroll pause + Follow (only when the line is actually off-centre), instant first snap, recenter on resize — and a flat dock: seek, transport, mute, queue.
- Queue: frosted floating panel, portaled to `document.body` so it renders above the immersive overlay (`.app` is `isolation:isolate` — z-index alone could not win), folded into the overlay's focus path, Esc-layered correctly.
- Settings: portaled sheet, first-control focus, container-edge Tab wrap, center-fill 8-band EQ sliders, honest capability states.
- Toasts: portaled to body at z-1200, above overlay and queue; top-left at narrow widths; dismiss joins the overlay Tab cycle.

**Interaction correctness** (the council found these; all fixed)
- `viewNonce` re-sync kills the store-view↔page desync — overlay opens from any page in one click; expansion auto-clears when both truths leave `now` or when the track nulls.
- `inert` on `.app` while the overlay is open — real focus containment instead of a counting trap.
- Buttons never take focus on mousedown — Space stays play/pause everywhere.
- Ctrl+arrows for volume; plain arrows scroll; SELECT/scrollable regions exempted correctly.
- Esc layering: queue → overlay → page, each layer's stop handled by its owner.
- Seek arrows act on the live position (the focused input's value goes stale by design).
- `navigate()` dedupes same-page entries; back/forward is real.
- Sidebar search passes its query into the library and clears after adoption.

**Data + engine (v1 residuals closed in v2)**
- Lyrics end-to-end: embedded tags + `.lrc` sidecars → `track.lyrics` (protocol), scanner, DB column + migration, mock LRC for headless use.
- FFT honesty: engine emits dBFS (−100..0); mock now emits the same units, and the shader normalizes dB→0..1 — the real route was silently dead before this fix.
- Palette extraction lifts chroma/luma so the wash is saturated, not murky (`liftColor`).
- `advance_track` parks ended readers for the monitor thread (no free on the audio callback); `FfmpegDecoder` reuses the plan's probe (kills repeat ffprobe runs); explicit feed errors; `audio.clearPrefetch` covered by test.

## How we verify visuals

`apps/desktop/scripts/capture.cjs` + `scripts/screenshot.sh` — offscreen `BrowserWindow` under Electron 45, `webContents.capturePage` → PNG, x11 ozone, `disable-gpu`, unique `userData` per run. Mock API via `?cadence_mock=1`; state driven through `window.__cadenceSession` (setView/setQueueOpen/setNowPlayingExpanded/seek/playTracks + store inspection). No Chrome/Playwright/Puppeteer, no visible windows. Known capture artifact: rAF-starved hidden windows can show lyrics mid-fade — seats verified the same frames in a real-paint harness before counting them.

## Council scores (per round; every seat ran the app headlessly and cited its own screenshots)

| Round | Visual+product | Visual design | Skeptical eng. | Eng+UX |
|---|---|---|---|---|
| R1 | Sol 6.0 | Terra 5.0 | Astra 5.0 | SWE-2 7.0 |
| R2 | Sol 7.5* | Terra 6.0 | Astra 6.5 | SWE-2 7.0 |
| R3 | Opus 7.0 | SWE-2 6.5 | Opus 6.0 | SWE-2 8.0 |
| R4 | Opus 7.0 | SWE-2 7.5 | Opus 5.0 | SWE-2 8.0 |
| R5 | Opus 7.0 | SWE-2 (cancelled at 21:00) | Opus 6.0 | SWE-2 8.0 |

\*R2 Sol ran on gpt-6-sol-medium (wrong model — marked provisional by the lead).

**Seat/model provenance.** Codex quota exhausted mid-R3 (reset ~19:50): Terra and Astra seats moved to `acpRegistry` (gpt-6-sol-medium / gpt-6-astra-medium) for one launch, then per Nirvaan's direction all Devin-routed seats became **Claude Opus 5.5** (visual+product, skeptical) and **SWE-2** (eng+UX, visual-design substitute). DeepSeek V4.1 Flash never ran — opencode delegation fails on "missing forward secret" on every attempt. Luna never touched UI (cancelled early, its partial work stashed, Terra reassigned).

## Verified

- ~90 ranked council findings fixed across five rounds, every one re-verified on screen or via DOM/store probes.
- 415 committed screenshots under `docs/design/screens/` covering home, library, album, sources, now playing, immersive, queue, settings, errors, 1440/900/640px windows.
- 38 desktop + 29 UI tests, 37 Rust tests, 0 TS errors at `bd83c06`.
- Keyboard: Tab cycles, Esc layering, Enter/Space behavior, arrows — all live-verified by skeptical seats.

## Not verified

- WebGL2/Pixi shader on real GPU (captures use software raster; CSS fallback wash is what screenshots show).
- Real audio output, provider sign-in/playback, DRM signing, device loss, Windows/macOS — unchanged from v1.
- Motion quality, hover affordances, drag-reorder, touch swipe — static captures can't judge.
- Photographic artwork palette extraction (mock uses synthetic covers); real library density.

## Remaining issues

- Playlists/pins/favorites: no API — nav sections honestly absent.
- Queue-replaces-lyrics in the overlay is a design choice; seats asked about a split view.
- `audio.feed` head-of-line, 600 ms promotion heuristic, exclusive output, MPRIS, provider queue mirroring — unchanged from v1.
- Mock lyrics are short; readable-lyrics (unsynced) mode unstyled vs synced.

## Run it

```bash
cd ~/dev/work/music-player && pnpm install
cargo build --manifest-path services/audio/Cargo.toml && pnpm -r build
pnpm --filter @cadence/desktop start          # real app
pnpm --filter @cadence/ui build
CAPTURE_PORT=4517 bash scripts/screenshot.sh shot "" 3000   # headless capture
```
