# Evidence and diagnosis

## Verdict boundaries

`ev.check` records a check and throws on required failure, ending that flow.
Unexpected exceptions become required crash checks. `ev.fail` records a required
failure without throwing. A failed check with `required: false` is a NOTE and
does not make the verdict FAIL. Ordinary transcript steps, including provider
skips and timing measurements, are not assertions.

`run` and `attach` write summaries for handled launch, selection and flow failures.
This is not an unconditional durability guarantee: invalid `--break` names exit
before summary handling, evidence I/O failures can prevent writes, attach lacks
the managed run's signal cleanup, and SIGKILL or machine failure bypasses cleanup.
Require both the process exit status and expected checks in `verdict.json`.

Attach appends the transcript and merges prior verdict checks with `prior: true`.
A prior required failure stays FAIL. Named screenshots and state files can be
overwritten by later flows or attach calls; use separate runs for independent proof.
`verify-runs/latest` changes on run/launch, including lifecycle selftests.

## Artifacts

| Path under the printed run directory | Use |
|---|---|
| `SUMMARY.md`, `verdict.json` | Human and machine verdict, checks and required flags. |
| `evidence/transcript.jsonl` | Ordered actions, checks, timing steps and artifact paths. |
| `evidence/*.png` | Flow screenshots, best-effort `fail-<flow>.png` and managed teardown state. |
| `state/*.json` | Flow-specific snapshots, queues, capabilities, routing and persisted settings. |
| `audio/*` | Local flow captures and analyzer JSON. |
| `logs/electron.log`, `logs/pipewire.log` | App/private-core output and launch diagnostics. |
| `session.json`, `asound.conf` | Recorded resource identities and private ALSA configuration. |

`verify-runs/` is gitignored. Evidence survives normal teardown and may contain
account details, search results, settings and captured music. Keep authenticated
evidence local unless the user requests sharing it.

## Negative controls

Run the corresponding positive flow first. Each deliberate break must produce
nonzero exit, FAIL, and evidence that the intended contract failed. A launch or
sign-in failure does not validate an audio negative control.

```bash
"$VERIFY" run smoke --break mute
"$VERIFY" run audio --break mute
"$VERIFY" run restart --break no-restore
```

Mute acts inside the private app session. For local captures, a rejected analyzer
may surface as `audio analysis completed` FAIL; read `audio/analysis-*.json` for
`capture not silent: false`, rather than requiring a specific top-level label.
`no-restore` deletes only this run's persisted settings between quit and relaunch.
Unknown breaks and breaks unsupported by the selected managed flows are rejected.

## Isolation and cleanup

The helper launches private Xvfb, PipeWire and policy-only WirePlumber without
hardware monitors, and routes ALSA and PulseAudio clients to the private core.
The app
environment drops selected session, display, audio, provider-token and binary/URL
overrides before pinning private coordinates and the repo audio binary. See
`helpers/src/lib/isolation.mjs` for the exact variable list; this is a test
isolation mechanism, not a general security sandbox.

A launch checks CDP socket ownership in the app process tree. Attach also checks
the recorded PID/start time, profile/port arguments and private display. Recorded
teardown checks identity before process kills; private audio sweeps match runtime
directory environment entries and audio process names. Keep these guards intact.
Use helper-managed capture and cleanup, never host-session pactl/pw commands,
broad process kills, or manual changes to the user's app.

Managed run handles SIGINT/SIGTERM, including resources acquired mid-launch.
For an interrupted interactive session, stop only your recorded `--run-dir`.
After SIGKILL/machine failure, metadata may be absent and temporary profiles can
remain. Directory removal alone does not prove processes exited. Confirm ownership
and that a directory is unused before removing a specific leftover; avoid wildcard
cleanup of `/tmp/cadence-*` or other agents' sessions.

## Diagnose a red run

1. Identify the first required failure in the summary and transcript. Read the
   flow source and artifacts to distinguish launch/dependency, locator/timing,
   analyzer, authentication and product failures.
2. For missing Electron/audio/UI builds, follow [setup](running.md). For native
   ABI errors, inspect the actual Node/Electron runtime and rebuild the affected
   module for that runtime; existence checks alone do not catch ABI mismatches.
3. A standalone providers flow can fail because the local audio service starts
   lazily. Follow [providers](../features/providers.md) to check readiness after
   smoke in the same session; preserve the standalone result.
4. For tap startup timeouts, inspect `logs/pipewire.log`. For occupied CDP, omit
   `--cdp` or choose a free port. For stale/foreign endpoint rejection, start your
   own new session and leave the unrelated endpoint alone.
5. For restore, inspect persisted playback, restored state and `quit mode`.
   `quitManaged` destroys windows before `app.quit()` to avoid the close-handler
   trap; this flow does not verify the tray Quit UI. Its bridge-resume fallback
   can pass the restore gate while transport failure remains a NOTE.
6. Reproduce a suspected product bug before attributing it. Historical resume
   resets and transition races are diagnosis leads, not proof that every red run
   is a product defect. Preserve strict required assertions and report non-gating
   gaps rather than weakening checks to obtain PASS.
