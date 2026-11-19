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

## Runtime and verification

Inspect `devDependencies.electron` in [package.json](package.json) and the lockfile
for the runtime under test. This branch uses Castlabs ECS; `electron:ecs` is an
informational script, not a dependency swap. DRM playback still depends on a
working Widevine component, signing/runtime compatibility, an active subscription
and a valid session.

For real UI, local audio, restore or Apple Music playback evidence, follow
[verify-cadence](../../.agents/skills/verify-cadence/SKILL.md). The dev flavor uses
built files with a private profile, display and audio core. Use that helper while
the user's instance may be running. Authenticated checks require a closed test
profile; leave an active source alone.

Always use `portless` for a development server. The root `pnpm dev` builds the UI
and launches desktop Electron; it does not start a UI server. The verification
helper also needs no server.

## Native module rebuilds

`better-sqlite3` compiles for Node during `pnpm install`, which is what
vitest uses. For the packaged Electron app the ABI differs — add
`@electron/rebuild` and run `pnpm dlx @electron/rebuild -f -w better-sqlite3`
for the intended Electron runtime. A rebuild can change which runtime the module
works with; inspect ABI errors and rerun the affected tests. The helper doctor
checks existence, not native-module compatibility.

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
