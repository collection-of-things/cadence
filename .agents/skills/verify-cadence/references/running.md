# Setup and sessions

All commands run from the repository root. `VERIFY` below is the helper path
set in [the skill](../SKILL.md).

## Build prerequisites

Inspect existing outputs first; build the changes you intend to test. The helper
uses built files, so a passing run against stale outputs does not verify edits.

```bash
pnpm install --frozen-lockfile
pnpm -r build
cargo build --manifest-path services/audio/Cargo.toml
"$VERIFY" doctor
```

The dev flavor resolves Electron from `node_modules/.pnpm/electron@*/.../dist/electron`,
loads `apps/desktop/dist/main.cjs` and `apps/ui/dist/index.html`, and pins the
repo audio binary from `target/debug`, falling back to `target/release`.
It does not launch Vite. If Electron's distribution is missing, run `install.js`
in the resolved Electron package directory. Keep the version in the lockfile;
copying a binary from another checkout can change the runtime under test.

System prerequisites include Node/pnpm, Cargo, ffmpeg/ffprobe, Python with numpy,
Xvfb, PipeWire, WirePlumber, pw-dump, pw-cat, pw-link, pactl, and the pipewire-alsa
plugin. PipeWire needs its PulseAudio protocol module for Chromium media.
Doctor checks tool/build existence and private tap startup on both sockets. It does not
explicitly check the ALSA plugin or native-module ABI; launch/audio can still fail.
Provider environment variables listed by doctor are informational and are stripped
from the spawned app. They do not authenticate a verification session.

The five checked-in chirp tracks live in `test/fixtures/library/`. `"$VERIFY" tracks`
lists them. Regenerate only when needed with
`bash .agents/skills/verify-cadence/helpers/gen-test-tracks.sh`.
The generated fixtures under `test/fixtures/generated/` belong to the separate
Rust probe, not these Electron flows.

For packaged checks, build packaging assets with
`pnpm --filter @cadence/desktop dist:dir`, then pass `--flavor packaged` to doctor
and run. The expected executable is `apps/desktop/release/linux-unpacked/cadence`.
The helper still requires and pins the repo audio binary, so this is not proof
that a distributed package contains a working bundled audio service.

## Command boundaries

| Command | Result |
|---|---|
| `doctor [--flavor dev\|packaged]` | Tool/build report and temporary private-core probe; exits nonzero on failed checks. |
| `selftest` | Runs every `helpers/test/*.test.mjs` using `node --test`; writes temporary test state below `verify-runs/.selftest-tmp`. |
| `run <flow[,flow...]>` | Managed launch, flows, teardown, summary and verdict. Defaults to smoke if omitted. |
| `launch` | Leaves a private interactive session running; prints session path and CDP port. |
| `attach <flows> --run-dir <dir>` | Runs flows after checking recorded process and endpoint ownership. Disconnects afterward; session remains running. |
| `snap --run-dir <dir>` | Prints snapshot and queue. |
| `shot <name> --run-dir <dir>` | Writes `evidence/<name>.png`. Use a plain basename. |
| `eval <js> --run-dir <dir>` | Runs renderer JavaScript; bridge is `window.cadence`. |
| `stop --run-dir <dir>` | Tears down recorded resources and removes owned temporary directories, retaining evidence. |
| `tracks` | Prints fixture paths. |

`run` accepts `--flavor`, `--slug`, `--break`, and `--user-data`.
`launch` accepts `--flavor`, `--slug`, `--user-data` and `--cdp <unused-port>`.
Omit `--cdp` for ephemeral allocation. `run --keep` is rejected. Use command names
and space-separated values as shown; the parser is not a general `--flag=value`
parser and there is no successful `--help` command.

## Interactive inspection

```bash
"$VERIFY" launch --slug inspection
# Use the absolute directory printed above in every subsequent command.
"$VERIFY" snap --run-dir /absolute/path/to/verify-runs/printed-session
"$VERIFY" shot inspection --run-dir /absolute/path/to/verify-runs/printed-session
"$VERIFY" eval 'window.cadence.getSnapshot()' --run-dir /absolute/path/to/verify-runs/printed-session
"$VERIFY" attach navigate --run-dir /absolute/path/to/verify-runs/printed-session
"$VERIFY" stop --run-dir /absolute/path/to/verify-runs/printed-session
```

Always specify `--run-dir`. The default uses `verify-runs/latest` or a newest
session fallback, which can select another agent's run. A launch writes session
metadata; successful launch alone does not write a flow verdict. Run `restart`
through `run`, since attach lacks a managed Electron handle. Use managed `run`
for negative controls too; attach does not propagate `--break`.

A fresh profile is the default. An explicit `--user-data` must name a nonexistent
path; existing directories are refused so concurrent sessions cannot share a
profile. Teardown removes the created profile after confirming it is unused.
Evidence directories and `session.json` are trusted harness inputs;
select your own session, rather than arbitrary or edited metadata.
