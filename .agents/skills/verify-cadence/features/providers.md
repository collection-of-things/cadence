# providers — pluggable, opt-in

Run: `cadence-verify run providers`

Reads `getCapabilities()` on the Sources page. `local` must be `ready`.
Streaming routes report readiness only; this flow does not test their
playback. Unavailable routes record a skip with the route's own reason
(e.g. `unauthenticated`, `unavailable`, librespot missing, Widevine not
signed). Apple Music's e2e lands on feat/apple-music; its flows can drop
into this directory unchanged.

Evidence: `sources-capabilities.png`, `state/capabilities.json`.
