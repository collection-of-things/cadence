---
name: verify-cadence
description: Verify Cadence's real Electron UI, local playback and audio, restart restore, or authenticated Apple Music playback. Use for end-to-end evidence, harness failures, and negative controls on a private display and PipeWire core.
---

# Verify Cadence

Drive the built Electron app on a private Xvfb display and PipeWire core. Use
this skill for real app evidence; mock screenshots, capability readiness, unit
tests, and formal models each cover different contracts.

## 1. Prepare

Run commands from the repository root. In the examples, set:

```bash
VERIFY=.agents/skills/verify-cadence/helpers/cadence-verify
```

Preserve existing changes and leave the user's running app, profile and audio
alone. Use only harness-owned sessions. Never run the legacy
`test/e2e/apple-music.mjs`: it changes the user's default sink and moves streams.
Any development server must use `portless`. The verification helper needs no
server, including with `--flavor dev`; it loads the built UI and strips
`CADENCE_UI_URL`.

Read [setup and session commands](references/running.md) for missing dependencies,
packaged builds, interactive inspection, or cleanup. Run `"$VERIFY" doctor` to
check available tools/builds and bring up and tear down a private audio core.
Doctor neither launches Electron nor proves authenticated provider playback.
Its isolation rows describe policy; `selftest` exercises the guards.

Preparation is complete when the selected flavor's builds exist and doctor
passes, or each blocking prerequisite is identified and reported.

## 2. Select the contract

Read the guide for each selected flow before running it. Use separate managed
runs when you need independent results; comma-separated flows share app state,
stop a failing flow at its first required assertion, and then attempt later flows.

| Flow guide | Contract and limits |
|---|---|
| [smoke](features/smoke.md) | Local fixture indexing, click-to-play, routed non-silent capture, pause. Start here for real app checks. |
| [audio](features/audio.md) | PCM level, reference alignment, seek and pause silence. Resume preservation is non-gating. |
| [navigate](features/navigate.md) | Sidebar destinations, visible search, history, queue, now playing, settings and Sources. |
| [playback](features/playback.md) | Transport, keyboard, seek and queue edits; queue removal uses the bridge and is conditional. |
| [library](features/library.md) | Fixture identities, albums/artists, artwork URLs, DB text filter, artist play and track-count chip. |
| [restart](features/restart.md) | Managed quit/relaunch, persisted queue/track/position, paused restore and routed resume. Requires `run`. |
| [providers](features/providers.md) | Capability readiness after local service startup; use `smoke,providers`. Unavailable streaming routes can pass as skipped. |
| [apple-music](features/apple-music.md) | Authenticated search, selected song, audio, pause and resume. Read profile prerequisites first. |

```bash
"$VERIFY" run smoke
"$VERIFY" run smoke,audio,navigate
```

For harness changes, also run `"$VERIFY" selftest`. It includes subprocess and
mid-launch signal tests that start private resources; it is not a pure unit suite.
For routing, capture, analyzer or restore changes, run the applicable positive
flow and [negative control](references/evidence.md#negative-controls).
For new flows or assertions, follow [extending the helper](references/extending.md).

## 3. Read the evidence

Use the exact `verify-runs/<timestamp>-<slug>/` path printed by the command.
Read `SUMMARY.md`, `verdict.json`, then the failing step and associated artifacts
in `evidence/transcript.jsonl`. [Evidence and diagnosis](references/evidence.md)
explains labels, failure boundaries, artifacts and cleanup limitations.

Completion requires the expected checks and evidence, not just a screenshot or
playing status. A normal run must exit 0 with a PASS verdict. A negative control
must exit nonzero with evidence of the intended broken contract. Report NOTEs,
provider skips, missing checks and blocked flows separately. A PASS covers only
the selected flows and their required assertions.

Report the flow/flavor, command, exit status, evidence path, required failures,
non-gating observations and remaining limitations. Finish by stopping any
interactive session you created, using its explicit `--run-dir`. Retain evidence;
start a fresh run to demonstrate a fix because attach preserves earlier failures.
