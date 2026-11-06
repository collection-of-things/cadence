# Cadence — fusion-b "Room tone"

One confident product: a Cider-faithful dark client with artwork-driven ambience,
a three-service platform switcher, and a Now Playing takeover with graduated-blur
synced lyrics.

## Concept

Cadence is a client for **one streaming platform at a time** — Apple Music,
Spotify, or YouTube Music — never a merged library. The whole app re-skins when
you switch: nav, shelves, playlists, library, search, and service identity
(glyphs, active marker, account). Local files sit alongside whichever platform
is active as a first-class secondary library (FLAC/ALAC badges, always
reachable, never gated behind connect).

Two colour systems keep it legible rather than muddy:

- **Chrome follows the platform** (`--svc`): switcher, nav marker, avatar,
  genre/search focus, connect sheet.
- **Playback follows the artwork** (`--acc`, cover-sampled): seek, play
  buttons, loved heart, playing-row EQ, the ambient wash itself.

A track that keeps playing across a switch keeps its source tile and shows
"· via {service}" in the player — provenance, not contradiction.

## What's inside

- `index.html` — the whole prototype (vanilla JS/CSS, Inter variable, sibling
  cover JPEGs in `covers/`).
- Home, Browse, Radio/Explore, Library (songs/albums/artists/recent), album,
  playlist, artist, search, and local-files views — all re-rendered per
  platform.
- Floating pill player: play/pause, prev/next, simulated seek (drag + arrows),
  volume (drag + ↑/↓, mute), shuffle, repeat off→all→one, love.
- Now Playing takeover: synced click-to-seek lyrics with Cider-style graduated
  blur, up-next card, quality badges; the pill persists underneath (Cider's
  own behaviour).
- Queue drawer with pointer-drag reorder, played-track dimming, named source.
- `⌘K` palette (actions, go-to, platform switch incl. connect), right-click
  menus on tracks/cards with target highlight, toasts, fake-OAuth connect
  flow for unconnected services, tasteful switch transition (blur+fade, spring
  indicator, service chip).
- Keyboard: `Space` play/pause, `←/→` seek ±5s, `Shift+←/→` prev/next,
  `↑/↓` volume, `L` now playing, `Esc` layered close.

## Council

Three seats reviewed real headless-Chromium screenshots at 1440×900 and
1280×800 across ~16 states each round (home, hover, album, now playing,
palette + empty, context menu, queue, connect, all three platforms, local).

| Seat | Model | R1 | R2 | R3 | Final |
| --- | --- | --- | --- | --- | --- |
| Terra | `codex/gpt-6.1-terra` (high) | 7/10 | 8.5/10 | 9/10 | pending |
| SWE 2 | `devin/swe-2-high` | 7/10 | 8/10 | 9/10 | pending |
| Fusion | `devin/fusion-claude-opus-5-5-medium-sidekick-swe-2-medium` | 7/10 | 8/10 | 8.6/10 | pending |

Fusion model note: the requested `fusion-claude-opus-5-5-high-sidekick-swe-2-medium`
is not delegatable; the seat ran on `fusion-claude-opus-5-5-medium-sidekick-swe-2-medium`
(Claude Opus 5.5 + SWE-2 sidekick). An earlier run on standalone `claude-opus-5-5-medium`
was cancelled and re-scored per Nirvaan's model rule.

### Last critiques (round 1 → round 2 fixes)

**Terra** — connect CTA was unstyled (`--csvc` scoped to the logo, not the
dialog); small text too faint; lyric neighbours unreadable; player truncation;
pill occluding content; NP square ring + stranded up-next; drawer cut content;
"Local" presented as a peer service; "Apple shell showing Spotify" read;
missing hover/state coverage; sidebar label duplication.

→ Fixed: CTA fill + dark ink, `--t3/--t4` raised (≈4.5:1), graduated lyric
blur, wider meta, up-next card, drawer dim, local as always-on row, declared
chrome=service / playback=cover rule, full hover coverage, "MUSIC" slab.

**SWE-2** — same CTA bug; weight ramp noise (~15 weights); t4 dim; blur
overcooked; badge fatigue; radius math inconsistent; search off-center; bolt
for shuffle; nav tick on panel edge; volume fill mismatched; love dot
redundant; accent-vs-platform rule undecided.

→ Fixed: weights locked 450/550/650/700/750, t4 → oklch(.64), blur ≤1.6px,
card badges removed, radius = inner+padding rule applied, search centred,
crossed-arrow shuffle glyph, inset tick, accent vol fill, filled heart.

**Fusion** — 19 weights / 20 sizes; tracking soup; lettermarks read as
placeholders; Apple/YT chrome indistinguishable; ambient too weak; no fade
under pill; local row wrapped; cards 10px right of headings; palette
highlight shrank to content; album rows repeated thumbs + dead INFO column;
queue hid rows + no clear label; past lyrics too bright; loved state
disagreed with itself; connect sheet mixed alignments.

→ Fixed: type normalized, brand glyphs (note/arcs/play), per-platform radii,
stronger ambient + NP glow, bottom fade, local row single line, cards
flush-left, palette full-width fixed rows, bare album rows, labelled Clear,
dimmer past lines + clean mask, filled heart, left-aligned connect copy.

### Remaining known limits (inherent, not fixable in a static prototype)

- No real audio/OAuth — connect simulates a 1.4s token round-trip.
- Line-level (not word-level) lyric sync; fake timings.
- Covers are AI-generated placeholders reused via hue variants.
- Painted window chrome; no native drag region.
