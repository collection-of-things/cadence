# verify-cadence — end-to-end verification for the real app

Launch the real Cadence Electron app headlessly, drive it the way a user
would, and come back with proof: screenshots, state dumps, PipeWire
captures, and a verdict. Nothing touches the user's screen or audio —
every run gets a private X display and a private PipeWire core.

## Quick start

```bash
.agents/skills/verify-cadence/helpers/cadence-verify doctor   # env sane?
.agents/skills/verify-cadence/helpers/cadence-verify run smoke      # ~1 min
.agents/skills/verify-cadence/helpers/cadence-verify run smoke,audio,navigate
```

A run writes `verify-runs/<timestamp>-<flows>/` and prints the verdict.
Read `SUMMARY.md` there first; every check and step is also in
`evidence/transcript.jsonl`.

## Commands

| command | what it does |
|---|---|
| `doctor` | checks binaries (electron, cadence-audio, Xvfb, pipewire, ffmpeg, python3+numpy), fixture tracks, and — destructively only for itself — spins a private PipeWire core to prove tap ports come up |
| `run <flows>` | managed session: launches the app, runs flows, kills everything, prints PASS/FAIL |
| `launch` | interactive session: leaves app + Xvfb + private PipeWire running, prints CDP + session.json paths |
| `attach <flows>` | runs flows against a `launch`ed session |
| `snap` | snapshot + queue JSON from a live session |
| `shot <name>` | screenshot from a live session |
| `eval <js>` | evaluate JS in the renderer (bridge: `window.cadence`) |
| `stop` | kill everything a `launch` left running (whole private graph, by runtime dir) |
| `tracks` | list the checked-in fixture tracks |

`run` flags: `--flavor dev|packaged` (packaged needs `dist:dir` output at
`apps/desktop/release/linux-unpacked/cadence`), `--pw private|session`
(default `private` — never touches the user's graph), `--user-data <dir>`,
`--keep` (leave the app + private graph running after the flows finish —
inspect it with `attach`/`snap`/`stop`), `--slug <name>` (run-dir suffix).

`launch` flags: `--cdp <port>` (DevTools port for attach, default 9333).

`attach`/`snap`/`shot`/`eval`/`stop` take `--run-dir <dir>` (the session
dir printed by `launch`); without it they use the most recent session.

## Flows

| flow | proves |
|---|---|
| `smoke` | launch, bridge ready, fixtures indexed (5), Library nav, album open, click-to-play, **stream routed to the verify tap**, pause |
| `audio` | real PCM out: monitor capture is **not silent**, **level sane** vs decoded reference, **pause silences the tap**, capture **aligns to the reference** (cross-correlation), **seek moved the source position** |
| `navigate` | sidebar sections, search finds a fixture, album open/back/forward, queue panel, now-playing overlay, settings sheet, Sources page |
| `playback` | click-to-play, position advances, pause/resume, spacebar toggle, seek-bar seek, next/previous, add-next, queue row jump, queue remove |
| `library` | 5 tracks / 2 albums / 2 artists indexed, artwork extracted, tab rendering, text filter, artist-row play, album facts |
| `providers` | `local` ready; streaming providers **skipped cleanly** when unauthenticated/unavailable (pluggable — they run when a signed-in profile exists) |
| `restart` | quit mid-track → relaunch → queue/track/position restored, comes back **paused**, no stray stream, resume works |

## Evidence layout (`verify-runs/<ts>-<flows>/`)

```
evidence/transcript.jsonl   every step + check + result, in order
evidence/*.png              screenshots (incl. fail-<flow>.png on failure)
session.json                session meta at run root — pid, display,
                            pw runtime dir, flavor (mirrored to state/)
state/*.json                getSnapshot/getQueue/capabilities dumps,
                            persisted cadence-settings.json copies
audio/monitor-capture.*     raw f32le + wav of the tap monitor
audio/analysis.json         silence/level/alignment/seek verdicts
                            (audio/ is only populated by the audio flow)
logs/pipewire.log           private daemon + wireplumber output
logs/electron.log           app stderr
SUMMARY.md                  one-page verdict
verdict.json                machine-readable result
```

## How isolation works

- **Display:** a private Xvfb (`:90`-`:119`, stale locks swept). Nothing
  ever appears on the user's screen.
- **Audio:** a private PipeWire daemon (`pipewire-verify.conf`) with a
  policy-only WirePlumber (`-p verify`, `wireplumber-verify.conf` — no
  hardware monitors, no dbus). It owns a dedicated null sink
  `cadence_verify` (F32LE/48k). The app is launched with
  `XDG_RUNTIME_DIR`/`PIPEWIRE_RUNTIME_DIR` pointing at this core, so its
  audio graph can ONLY reach the tap. `pw-cat` records the sink's monitor
  ports — the same shared-tap method the issue-1 harness proved.
- **Profile:** each run gets a fresh `--user-data-dir` under /tmp; nothing
  in the real profile is touched.
- `ELECTRON_RUN_AS_NODE` is stripped from the app env (it turns the
  Electron binary into node and nothing launches).

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

## Known product defects the suite exposes

The flows assert the product contract. On current `main` these checks
flag real defects — the harness is right; the app is wrong. Evidence is
in the run dirs.

- **`app.quit()` hangs unless the window is destroyed first.**
  `win.on('close')` calls `preventDefault()` whenever the tray menu's
  `quitting` flag is unset — and only the tray Quit item sets it. Every
  programmatic quit path (evaluate, logout, shutdown) traps: the process
  never exits. `quitManaged` works around it by destroying windows before
  `app.quit()` and reports `mode=graceful|killed` in the transcript.
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

`providers` iterates capabilities from `window.cadence.getCapabilities()`:
- `local` must be `ready`.
- streaming routes (`youtube-music`, `apple-musickit`, `spotify-*`) are
  exercised **only when the capability reports signed-in/ready**; anything
  else is asserted as a clean skip with its reason recorded.
- Apple Music E2E is being built on `feat/apple-music` — when it lands,
  drop its flow files into `helpers/src/flows/` and they run via
  `run <name>`; capabilities already cover the skip/ready decision.

## Adding a flow

Drop `helpers/src/flows/<name>.mjs` with `export const name` and
`export async function run(ctx)`. `ctx` gives you `page` (playwright
page), `ev` (evidence), `pw` (PipeWire scope), `meta`, `ud`, `runDir`.
Assert with `ev.check(name, ok, detail)` (throws on fail — record
observations with `{ required: false }` when the point is evidence, not
gating). Helpers in `lib/flow.mjs`: `seedLibrary`, `navTo`,
`openAlbumByName`, `clickTrack`, `assertAudioRouted`, `shot`, `dumpState`.
The file self-registers in `cli.mjs`'s flow table — add the import there.

## Troubleshooting

- `no free X display` — stale `/tmp/.X*-lock` from killed Xvfbs; the
  launcher sweeps dead-PID locks automatically.
- `Electron binary not found` — `node_modules/.pnpm/electron@*/node_modules/electron/dist/electron`
  must exist (copy `dist/` from a sibling worktree if install is blocked).
- `cadence-audio binary missing` — `cargo build --manifest-path services/audio/Cargo.toml`.
- tap port timeouts — the private WirePlumber can take ~30s on first
  connect; the harness already waits. Check `logs/pipewire.log`.
- `run` leaves strays after a crash — `pw`/`wireplumber`/`Xvfb` from a
  killed run are cleaned by the next `launch` (runtime-dir + lock sweeps)
  or `stop`.
- electron.log empty — managed launches pipe `app.process()` stderr, which
  only carries output after playwright's own launch handshake; an app that
  crashes before then logs nothing. Interactive `launch` writes stderr to
  a real fd and always captures.
