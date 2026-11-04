# @cadence/desktop

Electron main + preload for Cadence: the shell, the playback coordinator,
the local route adapter, the supervised `cadence-audio` JSON-RPC client, the
SQLite/FTS5 library, and the `window.cadence` IPC bridge.

## Layout

- `src/main.ts` — composition root (wires services, opens the window).
- `src/preload.ts` — `contextBridge` implementation of `window.cadence`.
- `src/ipc.ts` / `src/ipc-channels.ts` / `src/ipc-validation.ts` — channel
  names, ipcMain handlers, and inbound payload parsers.
- `src/coordinator/` — queue state, playback leases (generation ids), the
  source-handoff sequence, per-route volume memory, JSON settings restore.
- `src/audio/` — cadence-audio process supervision, stdio JSON-RPC framing,
  `PcmStreamSink` for provider PCM (fifo fast path + `audio.feed` fallback).
- `src/adapters/` — `AdapterRegistry`, the `local` route adapter, optional
  capability ports (`RestartRestorable`, `FidelityCapable`), and honest
  placeholder adapters. **Provider adapters live in `src/adapters/providers/`
  and are maintained by the lead — do not create files there.**
- `src/library/` — better-sqlite3 + FTS5 index, music-metadata scanner,
  chokidar watcher, folder-picker seam.
- `src/media-keys.ts` — best-effort `globalShortcut` media keys.

## Commands

```bash
pnpm install
pnpm typecheck   # tsc --noEmit (strict)
pnpm build       # tsup -> dist/main.cjs + dist/preload.cjs
pnpm test        # vitest (no Electron, no display needed)
pnpm dev         # build + launch Electron (needs a display)
```

Fixtures for the library tests are generated from the worktree root with
`bash scripts/gen-fixtures.sh` (needs ffmpeg); the test regenerates them if
missing.

## Electron runtime: stock vs Castlabs ECS

`electron` is pinned to **45.1.0** (stock) for dev/typecheck. Castlabs ECS is
not on npm; for the DRM build swap the dependency spec one line:

```jsonc
// package.json (or a pnpm.overrides entry in the root package.json)
"electron": "github:castlabs/electron-releases#v44.10.0+wvcus"
```

Pick an ECS tag from https://github.com/castlabs/electron-releases/releases
matching a supported release series (v45.x was still "in development" at pin
time — v44.x is the newest fully supported series). The repo's `install.js`
downloads the correct platform binary; `electron.d.ts` stays API-compatible.

**EVS signing TODO (packaged builds):**
- Dev builds are VMP-signed for development and work against Widevine UAT.
- Production requires an EVS signup (https://castlabs.com) and running
  `python3 vmp-resign.py` (or `evs-sign`) against the packaged app.
- Linux ECS support is partial and lacks persistent licenses.

`main.ts` already awaits `components.whenReady()` when the ECS-only
`app.components` API exists — no main-process changes are needed for the swap.

## Native module rebuilds

`better-sqlite3` compiles for Node during `pnpm install`, which is what
vitest uses. For the packaged Electron app the ABI differs — add
`@electron/rebuild` and run `pnpm dlx @electron/rebuild -f -w better-sqlite3`
in packaging CI (TODO: wire into electron-builder when packaging lands).

## Environment

- `CADENCE_AUDIO_BIN` — absolute path to the `cadence-audio` binary.
  Default resolution: `services/audio/target/{debug,release}/cadence-audio`
  relative to the repo root.
- `CADENCE_UI_URL` — renderer URL (e.g. Vite dev server). Without it, the
  shell loads `apps/ui/dist/index.html` if built, else a placeholder page.
- `CADENCE_APP_VERSION` — set by main for the preload `versions.app` field.

## Protocol deviations (reported, pending protocol update)

- `audio.load`'s `pcm-stream` source gains an optional `fifoPath` and the
  client adds an `audio.feed` method (`{queueId, data|end|abort}`) — the
  contract underdetermines how PCM reaches the service.
- Queue ids are coordinator-owned: incoming `QueueItem.queueId`s are
  re-stamped to guarantee uniqueness.
- `QueueState.owner` is derived from the active route (`local` and
  `spotify-librespot` = coordinator, provider engines = provider).
- `setQueue` autoplays by default only when `startIndex` is given.
