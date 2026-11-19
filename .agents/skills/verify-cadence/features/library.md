# library: indexing and browsing

Run: `.agents/skills/verify-cadence/helpers/cadence-verify run library`

After `library.scan` of `test/fixtures/library`: 5 tracks, 2 albums
(Signal Atlas, Field Notes), 2 artists, embedded artwork on all 5,
library tabs via the sidebar (Albums/Artists/Songs), DB-level text
filter, artist page play with artist identity Vector Choir, and an album chip containing
"3 tracks". Genre/year chip values, rendered artwork pixels and audible output
are not asserted by this flow.

Evidence: `evidence/artists.png`, `evidence/tracks.png`, `evidence/album-facts.png`,
`state/library-entities.json`.

For setup, isolation, evidence interpretation and completion criteria, return to
[Verify Cadence](../SKILL.md).
