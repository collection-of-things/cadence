# Cadence — fusion-b "Room tone"

One confident product: a Cider-faithful dark client on a deep neutral base, with a
living cover-colour shader behind the whole app, a three-service platform
switcher, and a Now Playing takeover with graduated-blur synced lyrics.

## Concept

Cadence is a client for **one streaming platform at a time** — Apple Music,
Spotify, or YouTube Music — never a merged library. The whole app re-skins when
you switch: nav, shelves, playlists, library, search, and service identity
(glyphs, active marker, account). Local files sit alongside whichever platform
is active as a first-class secondary library (FLAC/ALAC badges, always
reachable, never gated behind connect).

Colour is layered, never a wash:

- **Base** — a deep, near-black neutral (`#060607`) with a neutral veil.
  Everything is legible from first paint.
- **Ambient field** — a real-time WebGL shader that slowly flows the *current
  cover's* colours behind the whole app: subtle in the chrome, fuller and
  brighter in Now Playing. It is driven by app state, never by the audio:
  - *track change* → ~2.8s colour morph (chrome accents morph on the same
    timeline via `@property` transitions)
  - *pause* → the flow settles and dims ~2×; Now Playing art + lyrics dim too
  - *Now Playing* → a `uMove` term opens the field wider with more hue variety
  - *idle >40s* → slower drift; *window blur* → near-still; *hidden* → rAF
    fully stopped; *prefers-reduced-motion* → a single static frame
  - renders at ~1/4 resolution with a ~30fps cap on a low-power GL context;
    DOM crossfade ambient is kept as the no-WebGL fallback
- **Chrome follows the platform** (`--svc`): switcher, nav marker, avatar,
  genre/search focus, connect sheet.
- **Playback follows the artwork** (`--acc`, cover-derived): seek, play
  buttons, loved hearts, playing-row EQ, the field itself.
- **The page you're viewing** (`--pgacc`): album/playlist/artist headers tint
  their own action buttons from the *viewed* item while the player keeps the
  playing track's accent.

A track that keeps playing across a switch keeps its source tile and shows
"· via {service}" in the player — provenance, not contradiction.

## What's inside

- `index.html` — the whole prototype (vanilla JS/CSS/GLSL, Inter variable,
  sibling cover JPEGs in `covers/`).
- Home, Browse, Radio/Explore, Library (songs/albums/artists/recent), album,
  playlist, artist, search, and local-files views — all re-rendered per
  platform.
- Floating pill player: centred transport + scrubber, play/pause, prev/next,
  simulated seek (drag + arrows), volume (drag + ↑/↓, mute), shuffle, repeat
  off→all→one, love. Re-centres to the window in Now Playing.
- Now Playing takeover: synced click-to-seek lyrics with Cider-style graduated
  blur, up-next card, quality badges; the pill persists underneath (Cider's
  own behaviour).
- Queue drawer with pointer-drag reorder (⌥↑↓ too), played-track dimming,
  named source; sizes to its content.
- `⌘K` palette (actions, go-to, platform switch incl. connect), right-click
  menus on tracks/cards with target highlight, toasts, fake-OAuth connect
  flow for unconnected services, tasteful switch transition.
- Persistent painted window chrome (traffic lights stay crisp over Now Playing
  and every overlay).
- Keyboard: `Space` play/pause, `←/→` seek ±5s, `Shift+←/→` prev/next,
  `↑/↓` volume, `L` now playing, `Esc` layered close.

## Council

Three seats reviewed real headless-Chromium screenshots at 1440×900 and
1280×800 across ~20 states each round (home, shader morph frames, album,
context menu, queue, palette, connect, platform switch, local, pause/resume,
Now Playing frames).

| Seat | Model | R1 | R2 | R3 | Final |
| --- | --- | --- | --- | --- | --- |
| Terra | `codex/gpt-6.1-terra` (high) | 8.5/10 | 8.8/10 | 9/10 | **9/10** |
| SWE 2 | `devin/swe-2-high` | 9/10 | 9.5/10 | 9.5/10 | **9.5/10** |
| Fusion | `devin/fusion-claude-opus-5-5-medium-sidekick-swe-2-medium` | 8.9/10 | 9.1/10 | 9.2/10 | **9.2/10** |

Fusion model note: as before, the requested `fusion-…-high-…` is not
delegatable; the seat ran on `fusion-claude-opus-5-5-medium-sidekick-swe-2-medium`
(Claude Opus 5.5 + SWE-2 sidekick).

## What changed this round

- Near-black neutral base (`#060607`), neutral veil and panels; platform tint
  and cover colour are accents, not a wash.
- The static blurred-cover ambient was replaced by the WebGL state-driven
  field described above.
- Glass materials rebuilt with real edge light (inset top/side highlights,
  bottom shade, inner sheen) and a deeper ambient umbra on every pop surface.
- Transport centred in the pill with a wider scrubber; pill re-centres in
  Now Playing; roomier time labels.
- Loved-heart column on track rows (visible when loved or on hover).
- Queue sizes to content; search no longer shifts on queue open; palette
  regained a thin scrollbar as its scroll cue; sidebar bottom mask +
  account-card separator.
- `#fadeB` shortened and hidden in Now Playing (it was a visible seam);
  deeper bottom scroll clearance so the last rows clear the pill.
- Mac-style shortcut glyphs (⇧ →, ⌥↑↓); proper `+` badge on the switcher;
  connect CTA uses a white label; connect copy left-aligned.
- Data fixes: Liquid State/Pastel Hours covers were swapped (chrome↔beach);
  `Chill Mix` cover updated.

### Round-3 critiques (final)

**Terra (9/10)** — wanted card metadata kept on one line and the third
up-next card clear of the pill at 1440×900. Both fixed (single-unit
truncation; the 3rd row now hides under 920px viewport height). No
inherent blockers reported.

**SWE 2 (9.5/10)** — one named blocker: the floating queue covered the
centred search field and the track table's TIME column at 1280. Fixed by
insetting the toolbar and view when the drawer opens (animated with the
drawer's own curve) — nothing slides under the glass. Also asked for a
held-state cue on pause: the seek fill now dims.

**Fusion (9.2/10)** — accent colours landed ~3s ahead of the field
(ease vs the shader's linear ramp — now on a matching curve); transport
sat ~24px right of centre (right cluster made symmetric with the left
block); NP titles needed a legibility shadow over the field; pill meta
mixed `—` and `·` separators (now uniform). Their remaining notes —
cover placeholders, "⇧→" vs macOS ⌘→ (ours is the honest binding), and
Spotify's Search nav duplicating the toolbar field (faithful to that
service's IA) — are deliberate or inherent.

### Remaining known limits (inherent, not fixable in a static prototype)

- No real audio/OAuth — connect simulates a 1.4s token round-trip.
- Line-level (not word-level) lyric sync; fake timings.
- Covers are AI-generated placeholders; local albums reuse tinted streaming
  covers and a few platforms share scenes.
- Painted window chrome; no native drag region.
- Stills can't prove motion smoothness; the shader's pacing needs a live view.
