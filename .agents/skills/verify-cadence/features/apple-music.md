# Apple Music: authenticated playback

Use the explicit `apple-music` flow for Apple Music playback evidence.
`providers` checks readiness only. Commands below run from the repo root, with
`VERIFY` set as in [the skill](../SKILL.md).

## Prerequisites and profile safety

Use a signed-in test profile that is already closed and available for copying,
with a valid Apple Music subscription, network access and a compatible DRM runtime.
Prefer a dedicated test account. If the available source profile is in use, leave
it and the user's app running. Report authenticated verification blocked until a
closed test source is available; continue local flows and harness checks.

```bash
"$VERIFY" run apple-music --profile-copy /absolute/path/to/closed-test-profile
```

`--profile-copy` is supported only by `run` and cannot be combined with
`--user-data`. It creates a temporary harness-owned profile and copies only
`Partitions/provider-apple`, optional `Local State`, and optional `WidevineCdm`.
It excludes symlinks, lock/cache entries and the ownership marker while walking
copied content. It does not copy the library DB, settings, other provider
partitions or a complete Chromium profile. It launches the copy, never the source.

The helper rejects a source with a Chromium lock or a live process carrying the
source profile argument. Use an already closed test source. An absent lock and
process argument cannot prove quiescence for every launch. Missing partitions,
expired or non-portable credentials, keyring-bound secrets and incompatible
Widevine can prevent the copied session from working. The helper strips inherited
provider tokens, so setting token environment variables is not a substitute.

The existing session must become ready without interactive sign-in. The flow
does not implement account login, subscription setup or DRM provisioning. Report
these prerequisites as blockers rather than claiming provider playback passed.

## What the flow checks

- Wait up to 90 seconds for `apple-musickit` capability state `ready`; failure
  records the last state and detail rather than skipping.
- Select Apple Music in the UI, search `Daft Punk`, wait up to 60 seconds for a
  song row or visible search error, and select the first song. Catalog ordering
  and the chosen title depend on the account/storefront and service response.
- Require playing state on the selected title and `apple-musickit` route, an
  app-tree-owned audio stream linked to the private `cadence_verify` sink, and
  position advancing on the same track.
- Pause, resume the same song within 3 seconds of the paused position, require
  resumed position advancement, then pause again.
- Analyze captured stereo 48 kHz f32le monitor samples for finite values and
  complete frames. Require at least 96,000 samples above absolute amplitude
  0.002 during the playing proof window, pause RMS below 0.002 with at least
  48,000 samples, and at least 48,000 audible samples after resume. These are
  interleaved sample counts, not seconds of continuous audio.

A normal run passes only when every required assertion passes. This proves the
short search/play/pause/resume journey and private audio delivery. It does not
prove a full-length track, seek/next/queue operations, user library or playlist
browsing, restart/session persistence, fidelity, other providers, hardware output,
or Windows/macOS behavior. Apple capture analysis uses its own threshold loop,
not the local fixture cross-correlation analyzer; it cannot identify the music
from the PCM alone. The UI title/route and stream ownership supply that context.

## Evidence and negative control

Read `SUMMARY.md`, `verdict.json`, `evidence/transcript.jsonl`,
`evidence/apple-search.png`, `evidence/apple-paused.png`, and
`audio/apple-monitor.f32le`. Failures attempt `evidence/fail-apple-music.png`.
The flow does not write a WAV, dedicated analysis JSON, or provider snapshot dump.
Search-submit-to-row and click-to-playing timings are transcript steps. Estimated
click-to-first-audible uses a 0.002 threshold and wall-time capture anchor; it is
a single approximate observation, not a benchmark or a timing assertion.

```bash
"$VERIFY" run apple-music --profile-copy /absolute/path/to/closed-test-profile --break mute
```

The mute control must fail `Apple Music reaches private monitor` after sign-in,
search and playback reach the audio check. A sign-in/launch failure does not
validate the control. Use a fresh managed run for each result.

Normal teardown deletes the copied profile. SIGKILL or machine failure can leave
`/tmp/cadence-verify-ud-*` containing credentials. Use the exact session metadata
to establish ownership and that a leftover is unused before cleanup. Evidence
remains in `verify-runs/`, including account information and captured music.
Provider requests and playback can affect server-side account state despite the
local profile copy. Keep evidence local and report any prerequisites not tested.
