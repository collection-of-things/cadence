# Music player prototype v1 — report

Date: 5 November 2026. Repo: `~/dev/work/music-player` (branch `main`, commit `1ec7996`).
Status: complete for the v1 vertical slice. Final council round R5 in flight at write time (Sol + Terra + Astra seats); scores appended below when received.

## What was built

A pnpm monorepo implementing the v3 council design — custom React/TypeScript
interface in an Electron shell, backed by a Rust audio service, with
replaceable provider adapters and one shared PCM graph.

- `packages/protocol` — shared contracts: `RouteAdapter`, `PlaybackLease`,
  `CoordinatorEvent`, `AdapterEvent` (`queueId`/`promoted`/`gapless`),
  `window.cadence` API, and the `audio.*` JSON-RPC wire (`load`, `prefetch`,
  `feed`, `play`, `pause`, `stop`, `seek`, `setVolume`, `setEq`,
  `listDevices`, `setDevice`, `setFidelityMode`).
- `services/audio` — `cadence-audio` Rust service. FFmpeg decode → bounded
  SPSC ring → EQ biquads + ReplayGain at source rate → rubato resample →
  pull-based `OutputCore` → pre-volume FFT tap → CPAL or null sink.
  Sample-exact gapless via prefetched second pipeline; honest `gapless:false`
  on format-mismatch boundaries with auto-reopen; fidelity bypass selected by
  intent (`plan.bypass`) not negotiated kind; per-track s32 bypass producer,
  f32/s32/i16 output; generation + track-instance gated commands and events;
  bounded `audio.feed` (4 MiB, 500 ms atomic push, abort-interruptible);
  `try_lock` real-time callback with silent-frame fallback; dump writer
  thread; dead-sink retry; producer finish-on-death; device-loss fallback;
  position-preserving rebuilds.
- `apps/desktop` — Electron main: coordinator (playback leases + generation
  ids, prepare→silence→start handoffs, serialized command chain, timeouts on
  every adapter call, route-local errors, promotion-aware gapless advance
  with adopted leases, ended dedupe by (generation, queueId), prefetch
  reconciliation on queue edits, queue persistence, per-route volume memory);
  `AdapterRegistry` with per-adapter capability timeouts; local file adapter;
  four provider adapters (librespot PCM route, Spotify web, Apple MusicKit,
  YouTube Music) with honest `Tri` capability records; sandboxed `persist:`
  provider sessions with injected controllers + `setAudioMuted` on stop;
  library scanner (music-metadata → SQLite/FTS5, 512 px thumbnail cache,
  incremental mtime scan + chokidar); validated IPC + preload; media keys;
  `powerMonitor` suspend/resume; close-to-tray; `cadence-art://` artwork and
  `cadence-app://` UI bundle schemes; `electron-builder.yml` + EVS signing
  hooks.
- `apps/ui` — React 18 + Zustand: Now Playing with PixiJS/WebGL2 ambient
  shader (domain-warped fbm, artwork-palette tint, 48 FFT bands normalized
  dB→linear, adaptive resolution), transport, seek, volume, shuffle/repeat,
  queue panel, virtualized library (albums/artists/tracks, FTS search, roots
  management), capability chips, SettingsSheet (fidelity switch, 8-band EQ,
  output-device picker), Sources view (route states, sign-in, streaming
  catalog search), mediaSession, reduced-motion fallback, full
  `MockCadenceApi` for dev.

## How to run it

```bash
cd ~/dev/work/music-player
pnpm install
cargo build --manifest-path services/audio/Cargo.toml   # cadence-audio
pnpm -r build
pnpm --filter @cadence/desktop start                    # Electron app
# or UI-only dev: pnpm --filter @cadence/ui dev           (mock API)
```

Packaged artifact: `pnpm --filter @cadence/desktop dist` — stages the UI +
`cadence-audio` + ffmpeg/ffprobe via `scripts/package-assets.sh`, then runs
electron-builder. `dist:dir` produces an unpacked layout (verified on disk).
Castlabs ECS: `pnpm electron:ecs` in apps/desktop before `dist`, with EVS
signing env vars (documented in `electron-builder.yml`).

## Verified (all run on this box)

- `bash scripts/verify.sh` → **VERIFY: PASS** (frozen-lockfile install,
  typecheck, build, all tests, fixture generation, audio probe — no
  discarded failures).
- Vitest: **65 tests** (36 desktop + 29 UI) — queue/lease/handoff, gapless
  promotion (single `play` per boundary, repeat-one replay on a fresh
  generation, fallback when no promotion arrives), stale-generation drop,
  FTS5, audio client lifecycle/backpressure, provider search, IPC
  validation.
- `cargo test`: **36 tests** — ring buffer, resample, EQ, FFT, all-fixture
  decode, MP3 gapless trim, sample-exact gapless boundary, fidelity bypass
  honesty, `gapless:false` on reopen, feed bound/abort/atomicity,
  stale-gen prefetch rejection, deadlock tripwire, null-sink join.
- Fixture probes: FLAC, WAV, MP3 (encoder-delay trim), ALAC-in-M4A,
  24-bit/96 kHz — decode + RPC load/play/position verified.
- Rendered gapless boundary: 264,598 stereo frames, max zero-run 2.
- **Packaged layout verified on disk**: `electron-builder --dir` produced
  `release/linux-unpacked` with `app.asar`, `resources/audio/linux-x64/
  {cadence-audio,ffmpeg,ffprobe}`, and `resources/ui/index.html` — matching
  every runtime resolver.
- `node --check dist/main.cjs` clean; the R1 `import.meta` CJS crash is fixed.

## Not verified

- No display: WebGL2 visuals, reduced-motion path, frame pacing — code
  reviewed only. The `cadence-app://` + `base:'./'` packaged-UI path is
  verified by layout, not by a rendered window.
- No provider accounts: librespot Premium login + audio-key behavior, YTM /
  Apple / Spotify-web sign-in and playback are wired but unexercised.
- No EVS signing or ECS binary: DRM routes honestly report `unavailable`.
- Device loss, hotplug, sleep/wake, Windows/macOS: coded, not run.
- FFmpeg staged binaries are shared-library builds — may need system libs on
  a clean machine (documented).

## Council scores

Three parallel read-only seats per round, each reviewing its own prior
critique + the changelog. Substitutions across rounds are noted (Sol hit
usage limits R1-R4 — internal SWE-2 seats substituted; R5 used Sol + Terra +
Astra via codex).

| Round | Seat A | Seat B (skeptical audio) | Seat C (product) | What changed |
| --- | --- | --- | --- | --- |
| R1 | 7.5 (SWE-2) | 6.5 (SWE-2) | 6.0 (SWE-2) | Flagship gapless coordinator bug; bundle `import.meta` crash; unbounded feed; RT deadlocks; no EQ/device UI; no tray; swallowed stop(); provider reachability. |
| R2 | 8.0 | 7.0 | 7.0 | Promotion fix, serialization/timeouts, RT-safety, S16, tray, cadence-art, SettingsSheet/mediaSession, Sources/search, librespot pump, YTM reinject, suspend/resume, electron-builder, position-preserving rebuilds, device fallback, pre-volume FFT. |
| R3 | 7.5 | 7.5 | 7.5 | Ended dedupe, knownQueueIds filter, prefetch reconcile, promotedQueueId guard (bug found: desync — fixed next round), monitor guards, dead-sink negotiated-order, librespot sink events, packaged paths, sign-in UX. |
| R4 | 8.0 | 6.8 | 7.0 | Verified-fix round: I32 wrong-pitch producer, dead-sink silent load, producer-death buffering, atomic feed, feed control frames, stall-clear, route-gated events, all timeouts, audioMute, quit-dispose, engine-down surfacing, cadence-app scheme + base './', removeRoots, FFT units, probe hardened. |
| R5 | pending (Sol) | pending (Terra) | pending (Astra) | Track-instance epoch guards, stall-clear protocol key, removeRoots prune + UI, next-at-end positionMs, EQ store state. |

## Top open issues (inherent or residual)

1. `audio.feed` blocks the single-threaded RPC loop up to 500 ms on a full
   buffer — bounded by design; a dedicated feed channel removes the
   head-of-line delay.
2. The 600 ms promotion window is heuristic; a true "prefetch starting"
   engine event would close it for format-mismatch reopens > 600 ms.
3. `exclusive` output unimplemented (CPAL has no exclusive mode) — bypass is
   honest but goes through the shared mixer.
4. Provider-owned queue mirroring (`queueChanged`) is contract-declared;
   no adapter emits it yet.
5. librespot needs an external binary + env credentials + Premium; Connect
   semantics mean provider-side skips can diverge from coordinator intent.
6. Apple needs a server-signed developer token endpoint (not shipped).
7. Repeat-one can't prefetch itself — restart with a gap by design.
8. No MPRIS — `globalShortcut` media keys are best-effort on Linux;
   `mediaSession` covers in-page only.
9. Small residuals: `ffprobe` runs per pipeline spawn (double-probe per
   load); `scratch16` may allocate on first callback; IPC broadcast reaches
   hidden provider windows (harmless noise).
