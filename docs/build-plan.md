# Build plan — prototype v1

Written by the lead after GPT 6.1 Sol's Codex usage limit made it
unavailable (reset ~03:27 IST). Sol rejoins at the council. This plan
implements the agreed architecture in
`~/dev/research/music-player-framework-council-v3.md` ("First prototype").

## Repo layout

```
music-player/
  packages/protocol/      @cadence/protocol — ALL shared contracts
  apps/
    desktop/              @cadence/desktop — Electron main+preload
    ui/                   @cadence/ui — React+Vite renderer
  services/audio/         cadence-audio — Rust binary crate
  scripts/                gen-fixtures.sh, probe-audio.mjs, verify.sh
  test/fixtures/generated — ffmpeg-generated audio (not committed)
```

## Workstreams (one git worktree each)

| WS | Worker | Owns | Deliverable |
| --- | --- | --- | --- |
| audio | Devin SWE-2 | `services/audio/` | Rust service: ffmpeg decode -> one PCM graph -> EQ/RG -> rubato -> FFT tap -> CPAL; gapless prefetch; fidelity bypass; JSON-RPC stdio + `--probe`/`--decode`/`--null-sink` CLIs; cargo tests |
| ui | (model varies) | `apps/ui/` | Now-playing + library + queue; PixiJS/WebGL2 reactive shader bg; TanStack Virtual; MockCadenceApi; vitest store tests |
| desktop | Devin SWE-2 | `apps/desktop/` minus `adapters/providers/` | Coordinator (queue, leases, handoff), audio client (supervision, pcm-stream+feed), local adapter, library (better-sqlite3 FTS5, music-metadata, chokidar), preload `window.cadence`, adapter registry + honest placeholders |
| adapters | lead | `apps/desktop/src/adapters/providers/` | YTM (hidden view + injected controller + youtubei.js catalog), Apple (MusicKit JS in music.apple.com, token endpoint hook), Spotify librespot (pipe sink -> PCM graph), spotify-web (honest fallback) |

Interfaces: everything meets at `packages/protocol` — no workstream edits
it; deviations are reported to the lead and reconciled at merge.

## Key decisions

1. **Decode via FFmpeg subprocess pipe**, not ffmpeg-next or symphonia.
   ffmpeg-next = hours of sys-crate risk tonight; symphonia's MP4 demuxer
   lacks gapless (per v3 doc, ALAC-in-M4A is a target). The CLI handles
   demux/trim metadata correctly for all four formats, and a `Decoder`
   trait keeps an in-process backend possible later.
2. **Audio service transport = newline-delimited JSON-RPC over stdio.**
   One supervised child, one channel, versionable methods; streaming PCM
   enters via `fifoPath` (zero-copy) or base64 `audio.feed` fallback.
3. **Gapless (local)**: prefetch the next track's decoder; on drain, append
   frames contiguously on the same device stream — no reopen when formats
   match. Format mismatch in fidelity mode => honest `gapless:false`.
4. **Adapters without accounts**: every route returns a real capability
   record (`unauthenticated`/`unavailable` vs `ready`), views and wiring are
   real, failures are route-local. MusicKit needs a token endpoint (env
   hook); librespot needs binary+credentials (detected, reported);
   spotify-web needs EVS signing (build hooks prepared, reported as
   unavailable).
5. **Electron**: stock `electron` npm pin for dev/typecheck (Castlabs ECS
   is not on public npm — verified); documented one-line swap to the ECS
   tarball + EVS signing TODO so signing slots in without restructuring.

## Sequencing

contracts -> workers in parallel -> merge (audio, ui, desktop, adapters) ->
repo-wide verify incl. `probe-audio.mjs` headless gapless session ->
council -> hill-climb.

## Top risks tonight

1. opencode free quota exhausted -> SWE-2 covers both seats; council third
   seat may need the same fallback.
2. Electron/renderer integration seams (preload path, IPC shapes) — mitigated
   by the fixed `window.cadence` contract + mock client.
3. CPAL device absence on this box -> `--null-sink` full-graph path is the
   verification surface.
4. Merge drift on shared files (package.json root, lockfile) — workers own
   disjoint dirs; lockfile conflicts resolved by reinstall.
5. Provider DOM selectors drift — controllers degrade to reported errors,
   never silent breakage.
