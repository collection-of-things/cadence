---
name: verify-cadence
description: Verify Cadence through the real Electron app on a private virtual display and PipeWire core, with smoke, audio, restart, UI flows, and evidence bundles. Use for end-to-end checks and deliberate regression controls.
---

# verify-cadence — end-to-end verification for the real app

Launch the real Cadence Electron app headlessly, drive it the way a user
would, and come back with proof: screenshots, state dumps, PipeWire
captures, and a verdict. Nothing touches the user's screen or audio —
every run gets a private X display and a private PipeWire core, and the
harness refuses every other option.

## Setup (cold agent)

```bash
pnpm install                       # workspace deps (playwright-core included)
node node_modules/.pnpm/electron@*/node_modules/electron/install.js   # electron dist
pnpm -r build                      # apps/ui/dist + apps/desktop/dist
cargo build --manifest-path services/audio/Cargo.toml   # target/debug/cadence-audio
```

Required system tools: `Xvfb`, `pipewire`, `wireplumber`, `pw-cat`,
`pw-dump`, `pw-link`, `pactl`, `ffmpeg`, `python3` + `numpy`, plus the
`pipewire-alsa` plugin (ALSA default device is routed to the private
core). `doctor` checks all of them.

```bash
.agents/skills/verify-cadence/helpers/cadence-verify doctor   # env sane?
.agents/skills/verify-cadence/helpers/cadence-verify selftest # harness regressions
.agents/skills/verify-cadence/helpers/cadence-verify run smoke      # ~1 min
.agents/skills/verify-cadence/helpers/cadence-verify run smoke,audio,navigate
```

A run writes `verify-runs/<timestamp>-<flows>/` and prints the verdict.
Read `SUMMARY.md` there first; every check and step is also in
`evidence/transcript.jsonl`. `run` and `attach` ALWAYS write
`SUMMARY.md` + `verdict.json` — including launch crashes, unknown flow
names, empty flow lists, and analysis failures. Exit code is non-zero
unless every required check passed.

## Commands

| command | what it does |
|---|---|
| `doctor` | checks binaries (electron, cadence-audio, Xvfb, pipewire, ffmpeg, python3+numpy), fixture tracks, and — destructively only for itself — spins a private PipeWire core to prove tap ports come up. NEVER probes the user's real audio session. |
| `run <flows>` | managed session: launches the app, runs flows, kills everything, prints PASS/FAIL |
| `launch` | interactive session: leaves app + Xvfb + private PipeWire running, prints CDP + session.json paths |
| `attach <flows>` | runs flows against a `launch`ed session — only after proving the recorded pid still owns the endpoint |
| `snap` | snapshot + queue JSON from a live session |
| `shot <name>` | screenshot from a live session |
| `eval <js>` | evaluate JS in the renderer (bridge: `window.cadence`) |
| `stop` | kill everything a `launch` left running (verified pids + private graph by runtime dir, owned temp dirs removed) |
| `tracks` | list the checked-in fixture tracks |
| `selftest` | harness regression tests (`helpers/test/*.test.mjs` via `node --test`) — isolation guards, verdict propagation, restart oracle, analyzer negatives |

`run` flags: `--flavor dev|packaged` (packaged needs `dist:dir` output at
`apps/desktop/release/linux-unpacked/cadence`), `--user-data <dir>`,
`--slug <name>` (run-dir suffix), `--break <name>` (deliberate breakage,
see Negative controls). `--keep` is rejected on `run` — a managed session
cannot reliably outlive the CLI process; use `launch` + `attach`/`stop`
for a persistent session.

`launch` flags: `--cdp <port>` (DevTools port for attach — must be
unused; omitted = ephemeral allocation, preferred).

`attach`/`snap`/`shot`/`eval`/`stop` take `--run-dir <dir>` (the session
dir printed by `launch`); without it they use the most recent session.

## Flows

| flow | proves |
|---|---|
| `smoke` | launch, bridge ready, all 5 fixtures indexed by identity, Library nav, album open, click-to-play on the expected track, stream routed to the verify tap, **real non-silent monitor capture**, pause |
| `audio` | real PCM out: monitor capture is **not silent**, **level sane** vs decoded reference, **pause silences the tap**, capture **aligns to the reference** (cross-correlation), **seek moved the source position** (delta + elapsed window time) |
| `navigate` | sidebar rows land on their views (incl. the Songs/Albums/Artists library tabs), search shows the fixture in visible rows, album open/back/forward, queue panel, now-playing overlay actually opens, settings sheet, Sources page |
| `playback` | click-to-play the expected track, position advances, pause/resume, spacebar toggle, seek-bar seek, next/previous, row-menu "Play next", queue row jump to the expected track, queue remove (all waited on predicates, not sleeps) |
| `library` | 5 fixture tracks / 2 albums / 2 artists indexed, artwork extracted, sidebar library tabs render, text filter, artist-row play, album fact chips |
| `providers` | `local` ready; streaming providers reported **ready/skipped per their own capability record** — readiness only, NOT provider playback E2E (pluggable — real provider flows can drop into `helpers/src/flows/` and gate on the same capabilities) |
| `restart` | quit mid-track → relaunch → same queue (ordered track identities + currentIndex), same track, meaningful nonzero restored position near the persisted point, comes back **paused**, no stray stream, resume plays the restored track with advancing, routed output |

## Evidence layout (`verify-runs/<ts>-<flows>/`)

```
evidence/transcript.jsonl   every step + check + result, in order
evidence/*.png              screenshots (incl. fail-<flow>.png on failure)
session.json                session meta at run root — pid, starttime,
                            display, pw runtime dir, cdp port, flavor
state/*.json                getSnapshot/getQueue/capabilities dumps,
                            persisted cadence-settings.json copies
audio/monitor-capture.*     raw f32le + wav of the tap monitor
audio/analysis-*.json       silence/level/alignment/seek verdicts
                            (audio/ is only populated by capture flows)
logs/pipewire.log           private daemon + wireplumber output
logs/electron.log           app stderr + launch-failure diagnostics
asound.conf                 the private ALSA default used by the app
SUMMARY.md                  one-page verdict
verdict.json                machine-readable result
```

`verify-runs/` is gitignored — evidence stays local.

## How isolation works

- **Display:** a private Xvfb (`:90`-`:119`, stale locks swept). Nothing
  ever appears on the user's screen.
- **Audio:** a private PipeWire daemon (`pipewire-verify.conf`) with a
  policy-only WirePlumber (`-p verify`, `wireplumber-verify.conf` — no
  hardware monitors, no dbus). It owns a dedicated null sink
  `cadence_verify` (F32LE/48k). The app is launched with
  `XDG_RUNTIME_DIR`/`PIPEWIRE_RUNTIME_DIR` pointing at this core, plus a
  private `asound.conf` (`ALSA_CONFIG_PATH`) whose default PCM is the
  pipewire plugin — its ALSA stream can ONLY reach the tap. `pw-cat`
  records the sink's monitor ports — never the app's own output ports.
  **There is no session mode:** `--pw session` is refused before any
  spawn; nothing loads sinks into the user's daemon or swaps its
  default, and teardown never sends pactl to the real session.
- **App env:** the spawned environment drops every route out of the
  private session — `DISPLAY`/`XAUTHORITY`/Wayland, `DBUS_*`,
  `XDG_RUNTIME_DIR`/session vars, `PULSE_*`, `ALSA_*`, `PIPEWIRE_*`,
  `CADENCE_UI_URL`, `CADENCE_AUDIO_BIN`, `CADENCE_LIBRESPOT_BIN`,
  provider tokens, `ELECTRON_RUN_AS_NODE`. Then the run re-pins what it
  owns: `DISPLAY` = the private Xvfb, the private core vars,
  `CADENCE_AUDIO_BIN` = the repo-built binary (missing → no spawn),
  `ALSA_CONFIG_PATH` = the run's asound.conf.
- **Profile:** each run gets a fresh `--user-data-dir` created and
  marked by the harness (`--user-data` may only point at a dir the
  harness marked — the real `~/.config/cadence` and any unmarked dir are
  refused). Owned profile/runtime/state dirs are removed at teardown;
  evidence is not.
- **CDP:** the DevTools port is ephemeral by default; an explicit `--cdp`
  is refused if occupied. After launch AND on every `attach`, the
  endpoint must prove it belongs to the recorded app pid (socket owner
  inside the pid's process tree, cmdline
  carrying the session's `--user-data-dir` and port, environ DISPLAY =
  the private Xvfb) — a stale or foreign browser is rejected.
- **Process safety:** kills verify recorded pid+starttime and
  cmdline/env ownership first (a reused pid is skipped, never killed);
  private-core sweeps match exact NUL-separated environ entries against
  audio-daemon comms only. SIGTERM/SIGINT during `run` still tear down
  and write the verdict.

## Negative controls (deliberate breakage)

Two `--break` hooks break the product contract inside the private
session only. Each MUST turn the run FAIL — if it doesn't, the harness
is lying, not the app.

```bash
# muted output — the monitor capture must be silent => FAIL
# "audio: capture not silent" (and the run verdict) must be FAIL
.agents/skills/verify-cadence/helpers/cadence-verify run smoke --break mute
.agents/skills/verify-cadence/helpers/cadence-verify run audio --break mute

# skipped restore — the persisted settings file is deleted between
# quit and relaunch => FAIL the restore gate
.agents/skills/verify-cadence/helpers/cadence-verify run restart --break no-restore
```

Use the managed commands above for reproducible negative controls.
For interactive inspection, use `cadence-verify launch`, then
`attach`/`eval` with its printed `--run-dir`, and finish with `stop`.
The `restart` flow requires `run restart`; an attached session has no
managed Electron lifecycle handle.

## Fixtures

`test/fixtures/library/` holds 5 checked-in, freely licensed chirp tracks
(2 albums × 2 artists, embedded artwork, CC0 public domain). Chirps make
cross-correlation alignment unambiguous. `helpers/gen-test-tracks.sh`
regenerates them deterministically; `cadence-verify tracks` lists them.

## Check labels

Every assertion is a check with PASS / FAIL / NOTE in the transcript,
SUMMARY.md and verdict.json:

- **PASS** — contract held.
- **FAIL** — a required check broke; the run verdict is FAIL.
- **NOTE** — an observation that failed but does not gate (`required:
  false`); used for evidence and for known product defects being tracked.
  NOTEs appear in verdict.json with `"required": false` and never turn a
  run red by themselves.

An `attach` into an existing run dir MERGES the earlier verdict's checks
(marked `prior: true`) — it can add evidence but can never rewrite a FAIL
into a PASS.

## Known product defects the suite exposes

The flows assert the product contract. On current `main` these checks
flag real defects — the harness is right; the app is wrong. Evidence is
in the run dirs.

- **`app.quit()` hangs unless the window is destroyed first.**
  `win.on('close')` calls `preventDefault()` whenever the tray menu's
  `quitting` flag is unset — and only the tray Quit item sets it. Every
  programmatic quit path (evaluate, logout, shutdown) traps: the process
  never exits. `quitManaged` works around it by destroying windows before
  `app.quit()` and reports `mode=graceful|killed` in the transcript; the
  restart flow's required gate expects `graceful`.
- **resume restarts from queue[0] at position 0.** Pause then Play:
  `paused Vantage@13959` → `playing Beacon@1365`; on Beacon (queue[0])
  it restarts the same track at ~0. (audio flow reports this as a NOTE,
  does not gate.)
- **resume-after-restore via the transport is inert.** After relaunch,
  clicking the Play button does nothing; `window.cadence.sendCommand`
  `resume` works and plays the restored item. (restart flow reports
  this as a NOTE, does not gate.)
- **previous after a transition race.** Meridian→Previous can land on
  Vantage when the coordinator's auto-advance fires between checks
  (position accounting around transitions is unreliable).

## Streaming providers

`providers` iterates capabilities from `window.cadence.getCapabilities()`
and reports route READINESS only — it does not prove provider playback:
- `local` must be `ready`.
- streaming routes (`youtube-music`, `apple-musickit`, `spotify-*`) report
  their capability state; unavailable routes record a skip and its reason.
- Apple Music E2E is being built on `feat/apple-music` — when it lands,
  drop its flow files into `helpers/src/flows/` and they run via
  `run <name>`; capabilities already cover the skip/ready decision.

## Adding a flow

Drop `helpers/src/flows/<name>.mjs` with `export const name` and
`export async function run(ctx)`. `ctx` gives you `page` (playwright
page), `ev` (evidence), `pw` (PipeWire scope), `meta`, `ud`, `runDir`,
`tracked` (resource registry — push recorders so teardown reaps them),
`breaks` (negative-control set). Assert with `ev.check(name, ok, detail)`
(throws on fail — record observations with `{ required: false }` when
the point is evidence, not gating) or `ev.fail(name, detail)` to record
a required failure without throwing (top-level catches). Helpers in
`lib/flow.mjs`: `seedLibrary`, `navTo`, `openAlbumByName`, `clickTrack`,
`assertAudioRouted`, `shot`, `dumpState`, `analyzeCapture`,
`fixtureForTitle`. The file self-registers in `cli.mjs`'s flow table —
add the import there.

## Harness regressions

`selftest` runs `node --test helpers/test/*.test.mjs` — fast, no app:

- `isolation.test.mjs` — pw-mode refusal, profile ownership guard, env
  sanitization, audio-binary pinning, port ownership (proc fd readlink),
  process identity checks, run-dir uniqueness.
- `evidence.test.mjs` — check/fail semantics, NOTE handling, prior-
  verdict merging, durable FAIL writes.
- `restart-oracle.test.mjs` — every clause of the restore contract,
  including stale persisted state and missing resume.
- `analyze.test.mjs` — analyzer rejects missing/empty/truncated/
  misaligned/NaN/too-short/silent captures and partial pause windows;
  accepts a real capture.

## Troubleshooting

- `no free X display` — stale `/tmp/.X*-lock` from killed Xvfbs; the
  launcher sweeps dead-PID locks automatically.
- `Electron binary not found` — `node_modules/.pnpm/electron@*/node_modules/electron/dist/electron`
  must exist (run `node install.js` in that package dir, or copy `dist/`
  from a sibling worktree if install is blocked).
- `cadence-audio binary missing` — `cargo build --manifest-path services/audio/Cargo.toml`.
- `CDP port N is already in use` — pass `--cdp <free port>` or omit for
  ephemeral; the harness refuses to risk an unrelated browser's port.
- tap port timeouts — the private WirePlumber can take ~30s on first
  connect; the harness already waits. Check `logs/pipewire.log`.
- `run` leaves strays after a crash — the next launch's private core is
  a fresh runtime dir; strays from a killed run are reaped by
  `stop`/`teardownRecorded` (verified pids) or die with their runtime dir.
- electron.log shows a `=== cadence-verify launch failure ===` section —
  the app never got far enough to pipe stderr; the recorded context is
  the diagnostic.
