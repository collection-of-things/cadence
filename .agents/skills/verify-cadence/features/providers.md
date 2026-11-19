# Providers: readiness

Run from the repo root: `.agents/skills/verify-cadence/helpers/cadence-verify run smoke,providers`.

The local audio service starts lazily. Standalone `run providers` on a fresh
profile can fail `local route ready` with `cadence-audio is not running yet`.
This flow does not start or wait for the service. Run smoke first in the same
managed session as shown above, or attach to your own session after playback.
Retain standalone failures as evidence; they are not proof of broken playback.

Open Sources, dump `getCapabilities()`, and require the local route to be ready.
For streaming routes, ready records the reported engine; unauthenticated,
unavailable and degraded states record a clean skip. An unexpected non-ready
state records a non-gating NOTE. A PASS can therefore include no streaming
playback at all. See `state/capabilities.json` and transcript provider steps for
which routes were skipped and why.

For authenticated playback, read [Apple Music](apple-music.md) and run that flow
explicitly. The providers flow does not invoke it, even when Apple reports ready.

Evidence: `evidence/sources-capabilities.png`, `state/capabilities.json`.
