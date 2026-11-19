# Cadence

An open-source desktop music player: Castlabs Electron shell, React + Vite +
TypeScript UI with PixiJS/WebGL2 visuals, and a Rust audio service (FFmpeg
decode into one PCM graph, FFT, CPAL output). Local library (FLAC/WAV/MP3/
ALAC) is first-class; Apple Music, YouTube Music and Spotify attach as
honest, capability-reporting routes.

Architecture decision record: see the council v3 design this prototype
implements (docs/prototype-v1.md links to it).

## Layout

- `packages/protocol` — shared contracts: tracks, queue, routes,
  capability records, coordinator events, audio-service JSON-RPC.
- `apps/desktop` — Electron main: shell, coordinator, library, adapters, IPC.
- `apps/ui` — React renderer: now-playing, library, queue, visuals.
- `apps/mobile`: Expo phone app: pairs over Wi-Fi, remote control, plays the queue on the phone (see its README).
- `services/audio` — Rust binary: decode -> PCM graph -> FFT -> CPAL.
- `scripts/` — fixtures + verify.
- `test/fixtures/library` — checked-in chirps for isolated Electron verification.
- `test/fixtures/generated` — generated Rust probe fixtures, gitignored.

## Quick start

```bash
pnpm install
pnpm build            # typecheck + build all packages
cargo build           # Rust audio service
pnpm verify           # all checks incl. Rust tests + headless playback probe
pnpm dev              # launches Electron dev (needs a display)
```

## Verification

For real Electron UI, playback/audio, restore, and authenticated Apple Music
checks, follow [verify-cadence](.agents/skills/verify-cadence/SKILL.md). It runs on
a private display and PipeWire core without closing the user's app or changing
its audio. The guide distinguishes readiness, playback proof and mock captures.

`pnpm verify` runs the checks in [scripts/verify.sh](scripts/verify.sh). Its Electron
smoke step can be skipped when the listed system tools are absent, so a final
PASS alone does not prove Electron ran. Read the step output and run the skill's
selected flows for end-to-end evidence. Harness regression tests are a separate
`cadence-verify selftest` command; authenticated provider flows are opt-in.

Any development server must run through `portless`. The isolated verification
helper uses the built UI and needs no server.
