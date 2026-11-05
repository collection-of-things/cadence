# Cadence v2 visual design plan

Date: 5 November 2026. Status: implementation brief. This pass changes documentation only. The four worker assignments below describe future work; no workers or council review were started.

## Direction and existing code

Cadence should feel like a quiet listening room: warm graphite, an apricot-coral control color, generous artwork, and a soft field of album color behind the page. Cider supplies the reference level of finish. Cadence gets its own identity through warmer neutrals, restrained typography, and a consistent accent that stays recognizable as albums change. Avoid pink-red chrome, glowing outlines, bouncing controls, and visualizer effects on text.

Read before writing this plan: `apps/ui/src/styles.css`, `App.tsx`, every file in `components/` and `visuals/`, plus `palette.ts`, `store.ts`, `hooks.ts`, the protocol, mock data, and screenshot scripts. Apply the requested `better-ui` and `emil-design-eng` fundamentals: concentric corners, optical icon alignment, neutral artwork outlines, interruptible transitions, and immediate keyboard actions. Existing React 18, Zustand, hand-drawn SVG icons, TanStack virtualization, and PixiJS 8 are sufficient. Add no animation or UI framework.

| Existing implementation | v2 implementation decision |
| --- | --- |
| `App.tsx` has inline top navigation for Now Playing / Library / Sources. | Extract the shell, add Home and a sidebar, and open Now Playing as an immersive overlay that remembers the browsing view. |
| `NowPlaying.tsx` owns artwork, shader, seek, transport, and capability details. | Move playback controls into one persistent `PlayerBar`; retain an immersive artwork view and add synchronized lyrics. |
| `LibraryView.tsx` plays albums and artists immediately when clicked. | Clicking artwork opens a detail page. Playback requires its Play button, a track play action, or an explicit card play action. Preserve album-title **and artist** filtering. |
| Tracks use a 46px virtualizer estimate; queue uses 56px. | Use a shared 60px track slot and a 64px queue slot, with rounded cards inside. Change both CSS and estimates together. |
| `palette.ts` samples 24×24 pixels and chooses saturated candidates using a coarse RGB bucket. | Use deterministic population-weighted colors, include neutral artwork, and separate browse artwork from playing artwork. |
| The shader consumes runtime FFT values directly; Rust emits dBFS but the mock currently emits 0…1 magnitudes. | Freeze the runtime contract as raw dBFS, correct the mock, and normalize once at the visual boundary. The prototype report's normalization claim does not match these files. |
| Shader time accumulates milliseconds and multiplies by `0.045`. | Make the uniform seconds and specify the drift period explicitly; avoid the existing unit ambiguity. |
| `TrackRef` already has optional `genre`, `year`, and raw `lyrics`; mock tracks include LRC lyrics. | Build metadata and lyric UI from these fields. Do not add a lyric network service. |
| No favorites, pin, playlist, or listening-history APIs exist. | Implement favorites, pins, and local playlists in a versioned renderer collection store. Home uses actual library data, with honest shelf labels. |
| `scripts/screenshot.sh` and `apps/desktop/scripts/capture.cjs` already capture mock UI under Xvfb. | Extend these for deterministic sizes and visual states. Preserve real-preload failure behavior in `api.ts`. |

## Design tokens

### Color and material

Use semantic CSS custom properties in a new `apps/ui/src/styles/tokens.css`. The values below are the initial exact palette. Fixed opaque text colors make contrast predictable. Artwork colors never replace these tokens.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0c0c0e` | Window and empty canvas |
| `--sidebar-bg` | `#121113` | Sidebar, nearly opaque |
| `--surface-1` | `#19181b` | Panels and static fallback |
| `--surface-2` | `#242226` | Inputs, inset groups, selected neutral tabs |
| `--surface-hover` | `rgb(255 255 255 / 0.065)` | Hover overlay |
| `--surface-selected` | `rgb(244 163 119 / 0.12)` | Selected track, separate from active navigation |
| `--glass` | `rgb(25 24 27 / 0.88)` | Player, queue, settings |
| `--lyrics-glass` | `rgb(25 24 27 / 0.76)` | Lyrics card, over a dark scrim |
| `--text` | `#f5f2ed` | Titles and active lyrics |
| `--text-dim` | `#bdb7b0` | Artist names, metadata, normal lyrics |
| `--text-faint` | `#928b83` | Secondary labels and time values |
| `--accent` | `#f4a377` | Apricot-coral Play pill, active sidebar pill, favorite state |
| `--accent-hover` | `#ffb68e` | Primary button hover |
| `--accent-ink` | `#24150f` | Text and glyphs on solid accent |
| `--border` | `rgb(255 255 255 / 0.10)` | Structural separation |
| `--border-soft` | `rgb(255 255 255 / 0.055)` | Quiet dividers |
| `--image-outline` | `rgb(255 255 255 / 0.10)` | Pure white 1px artwork outline, inset by 1px |
| `--success` / `--warning` / `--danger` | `#a5d6b0` / `#e6c18c` / `#f39e96` | Text plus icon or label, never color alone |
| `--focus` | `#ffd5b5` | 2px focus ring with 3px dark separation |

Text contrast must be checked on the composited result, including the brightest allowed artwork background. Target 4.5:1 for normal text and 3:1 for large text and essential control graphics. Use a dark control track with a sufficiently bright filled section and thumb. Disabled text may dim, but explanatory copy remains at `--text-dim`. Do not lower an entire settings section's opacity as the current `.set-dim` does.

Glass uses `backdrop-filter: blur(24px) saturate(1.1)`. Lyrics may use 32px. Restrict backdrop blur to these bounded panels; no full-window CSS blur over an animated canvas. Supply opaque `--surface-1` when backdrop filtering is unavailable and an explicit opaque-material setting for screenshot fixtures. Keep the sidebar at least 96% opaque over any atmosphere.

### Radii and spacing

| Tokens | Exact values and assignments |
| --- | --- |
| `--radius-xs/sm/md/lg/xl/2xl` | `6 / 10 / 14 / 20 / 28 / 36px` |
| `--radius-pill` | `999px`; pills and circles must also have explicit heights |
| Artwork | 20px shelf/grid art, 28px detail art, 28px immersive art, 10px player thumbnail |
| Rows and controls | 14px track cards, 20px queue container, pill toolbar groups, 10px menu items |
| Nested surfaces | Calculate `outer radius = inner radius + inset` for closely nested matching rectangles. A 28px panel with 8px inset gets a 20px inner surface. A player thumbnail at an asymmetric inset is an independent object. |
| `--space-1/2/3/4/5/6/8/10/12/16` | `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64px` |
| Default gaps | 8px inside controls, 12px between related controls, 24px between card columns, 40px between shelves |
| Control targets | 40×40px toolbar icons, 44×44px row action targets, 48px detail action circles, 48px primary Play pill height |

Use logical padding and min-width: 0 on text-bearing grid/flex children. Do not apply a large radius to every wrapper. Shelves and the track list have no enclosing card; their content sits directly on the atmosphere.

### Typography

Use `system-ui, -apple-system, 'Segoe UI', sans-serif` so Electron screenshots need no network font. Do not depend on the current unbundled Inter name. The design must work with Linux system metrics as well as macOS. Body weight 400, controls 600, headings 700; no weight above 750. Make type hierarchy with weight and color before increasing size.

| Token | Size / line height | Weight / tracking | Use |
| --- | --- | --- | --- |
| `--type-caption` | 12 / 16px | 500 / 0 | Time, metadata chips, provider labels |
| `--type-small` | 13 / 18px | 400 or 600 / 0 | Secondary rows, sidebar sections |
| `--type-body` | 14 / 20px | 400 / 0 | Track rows and descriptions |
| `--type-control` | 14 / 20px | 600 / 0 | Pills and navigation |
| `--type-card` | 16 / 22px | 600 / -0.01em | Shelf titles and player title |
| `--type-section` | 24 / 30px | 700 / -0.02em | Shelf headings |
| `--type-page` | 36 / 40px | 700 / -0.03em | Library, Sources, Home |
| `--type-display` | 48 / 52px | 750 / -0.035em | Album/playlist title, clamp to 32px in narrow detail |
| `--type-lyric` | 36 / 46px | 700 / -0.025em | Active immersive lyrics, clamp 28…40px |

Use sentence case for controls and sections. Use `tabular-nums` for time, duration, counts, and EQ values. Detail titles wrap to two lines before reducing to 32px; allow further wrapping for unusually long names. Player title and artist each ellipsize on one line with an accessible full name. Shelf card titles allow two lines. No auto-running title marquee. Lyrics wrap naturally and stay selectable. Remove global `user-select: none`; apply it only to control chrome and draggable artwork.

Keep the existing SVG family, normalize outline stroke to 2px on the 24px viewBox, and render at 16, 20, or 24px. Filled playback glyphs remain filled; favorites use outline and filled states. Icons use `currentColor`. Optically shift the play triangle 1px right at 20px, 2px at 26px. Navigation chevrons mirror in RTL; media transport does not.

### Shadows and grain

| Token | Value |
| --- | --- |
| `--shadow-control` | `inset 0 1px 0 rgb(255 255 255 / .06), 0 2px 6px rgb(0 0 0 / .18)` |
| `--shadow-art` | `0 8px 20px rgb(0 0 0 / .22), 0 24px 64px rgb(0 0 0 / .30)` |
| `--shadow-float` | `0 0 0 1px rgb(255 255 255 / .07), 0 12px 32px rgb(0 0 0 / .28), 0 28px 80px rgb(0 0 0 / .28)` |
| `--shadow-popover` | `0 0 0 1px rgb(255 255 255 / .09), 0 16px 48px rgb(0 0 0 / .45)` |

Use shadows for depth and borders for separators, selection, and focus. Hover changes the surface tint rather than animating a large shadow. Large artwork may have a static palette-colored shadow at alpha ≤ .16; it never pulses.

Create one bundled, seeded 128×128 monochrome grain PNG at `apps/ui/public/textures/grain.png`. Tile at 128 CSS pixels, opacity `.025`, normal blending, no animated seed or filter. Place it above the atmosphere but below artwork, text, and controls. It is decorative, `aria-hidden`, and `pointer-events: none`. The identical tile and opacity apply to CSS and WebGL fallbacks. Do not stack another noise layer in the shader.

## View-by-view layout specifications

All dimensions are CSS pixels. Main design sizes are 1440×900 and the existing 1280×800 default window. Respect the current Electron minimum of 720×480; do not raise it to conceal overflow. Native window decorations remain native. Any future frameless titlebar is a separate shell change.

### App shell, sidebar, and top bar

Use a two-column app grid: sidebar plus `minmax(0, 1fr)`. The right column contains an 80px top bar and a bounded main view. Sidebar and view lists scroll independently. Window/body never scroll. The floating player is positioned against the right-column bounds. All scroll regions reserve its complete height plus bottom clearance.

| Window width | Sidebar | Main horizontal padding | Player |
| --- | --- | --- | --- |
| ≥1360px | 248px | 40px | 96px tall, inset 16px |
| 1100…1359px | 224px | 32px | 96px tall, inset 16px |
| 900…1099px | 72px icon rail by default; toggle opens 248px overlay | 24px | 112px compact bar |
| 720…899px | 72px icon rail; same overlay | 24px | 112px compact bar |

Manual sidebar collapse uses the same 72px rail at larger widths. This preserves a visible search button and navigation. At heights below 600px, top bar becomes 64px and vertical content spacing uses 24px. Component adaptations use available container width, not assumptions about window width.

Sidebar: 20px horizontal padding, Cadence wordmark at 24px from the top, 24px gap to a 40px search pill. Home sits above four collapsible sections: Library, Pins, Playlists, Sources. Section labels are 12px/16px semibold, no uppercase letter spacing; section header target is 32px high. A section starts 24px after the previous section. Rows are 40px high with a 20px icon, 12px icon-label gap, and 12px inline padding. Active destination gets solid `--accent` with `--accent-ink`; hovered inactive rows get the neutral hover fill. Use `aria-current="page"`. Expanding a section uses a button with `aria-expanded`; no height animation.

Library contains Albums, Artists, Tracks, Favorites. Pins contain actual pinned albums/playlists. Playlists contain local playlists plus a Create playlist action. Sources lists real routes with a status dot **and accessible status text**. Empty sections show one quiet sentence and their relevant action. Bottom settings control is separated by flexible space; it remains reachable when the list scrolls. Rail icons have tooltips and accessible names. Hidden section children are removed from focus order.

Top bar: three columns `1fr auto 1fr`, 24px side padding. Left has a 40px-high back/forward group and sidebar toggle separated by 12px. Back/forward navigate UI history only and disable at boundaries. Center has a padded pill group, Home / Library / Sources, with a neutral filled selected capsule. Album, artist, favorites, and playlist routes select Library. Right has add, lyrics, queue in one pill group; settings remains in the sidebar. All are real buttons, 40px targets, 20px glyphs. Queue count caps visually at `99+` while its accessible label uses the real count.

At right-column widths below 800px, top bar uses 12px padding and 36px visual buttons with 40px targets; move Add into the sidebar's creation action to fit the three center labels. Do not overlap groups or rely on ellipsized icon buttons. Lyrics opens immersive Now Playing with lyrics enabled; it does not open an unrelated lyrics drawer. With no track, disable it with a reason. Add opens a small menu for Add folders and Create playlist.

Layer order: atmosphere 0, grain 1, view content 10, top bar/sidebar 20, player 30, nonmodal queue 40, immersive overlay 50, modal scrim 60, modal panel 61, toasts 70, tooltips 80. Each overlay gets a deliberate stacking context; avoid accidental transforms on the whole app.

### Home

Content starts 24px below the top bar. Use a simple `Home` heading and the optional factual line `Your library, ready to play`. First shelf starts 32px below it. No greeting that depends on the clock and no fabricated recommendations.

Use horizontal shelves with heading left and 36px circular previous/next buttons right. Gap between shelves is 40px. Default shelf card width is 240px at ≥1000px available width, 208px below that, 184px below 700px. Gap is 20px. Show a partial next card to communicate horizontal scrolling. Use scroll-snap proximity; arrow moves one visible shelf width minus one card. Disable the appropriate arrow at each boundary. Wheel vertical scrolling remains vertical; Shift+wheel or trackpad horizontal movement can scroll a shelf.

Card artwork is square with a 20px radius, a bottom overlay from transparent at 40% to black at 94%, and title/artist at 16px inset. A separate 44px play target appears at bottom right on hover or focus; it remains visible on coarse pointers. Use sibling detail-link and play-button elements rather than nesting a button inside a link. Gradient-backed captions require a minimum black scrim of 70% at the text baseline. Hover adds a small white veil; no card lift or zoom.

Initial shelves are `Albums` from the library response order, `Pinned` from the local collection store, and `Playlists` from local playlists. Omit empty optional shelves. Do not label library response order `Recently added` until the API supplies an ordering contract. Empty Home shows a 320px-wide quiet illustration area using the existing note icon, `Bring your music to Cadence`, and Add folders / Browse sources actions. A scan shows counts and a thin progress line without replacing usable shelves.

### Library, search, and artist pages

Library header: page title plus a small library count if known, with Add folders and Folders actions aligned right. The top bar already provides app-level navigation. Library's Albums / Artists / Tracks segmented filter sits 24px below the heading, with local search alongside it when enough width exists. Sidebar search navigates to a Library search result route using the same query and filtering implementation. Avoid two independent query states. Keep the existing 250ms debounce and add request sequencing for stale responses.

Album grid uses `repeat(auto-fill, minmax(180px, 1fr))`, 24px column gap, 28px row gap. Art remains square; title and artist sit outside the art at 10px and 4px gaps. Grid cards have no surrounding background. Artist list uses 64px rounded rows with a 44px circular initial avatar where art is unavailable; clicking opens an artist detail route with their albums and tracks. Favorites is a track list from the collection store with the same row specification.

Preserve current scanning, folder picking/removal, route indicators, and empty/error feedback. Put folder paths in a secondary expandable section; removing a root must still refetch the library. Paginate using existing `LibraryQuery.limit/offset`; a virtualizer alone does not overcome the current default 500-track result cap. Fetch 100-track pages, append with deduplication, and cancel obsolete queries. Album and artist collection pagination must follow their actual API behavior rather than assuming unsupported sorting or totals.

At list container widths ≥900px, track columns are `32px 40px minmax(160px, 1.4fr) minmax(100px, 1fr) minmax(100px, 1fr) 64px 48px 44px` with 12px gaps and 12px inline padding. Columns are number/play, art, title, artist, album, route, duration, action. Below 900px remove the album column. Below 700px move artist below title and route into the overflow details; retain title, duration, play, and action. Use a shared column template for header and rows.

Every track slot is 60px; the visible rounded card is 56px with a 4px bottom gap. Use a very quiet white 2% base fill, hover 6.5%, and accent 12% for selected/playing. Playing has an accent title plus a static playing glyph or restrained FFT indicator; selected and playing must remain distinguishable. Paused uses a static pause glyph. Keep visible 40px artwork with 10px corners. Duration is right-aligned and stable width. Unavailable tracks retain their label and reason and cannot start playback.

Use a list of row containers with a real title/play button and separate actions. Do not retain `role="button"` wrappers around nested buttons. Row click may start playback except on interactive descendants; keyboard Enter/Space on the title button does the same. Overflow and Play next are available on focus as well as hover. Virtualized focus needs stable IDs and a strategy that scrolls a row into range before focusing it. Match estimateSize to 60 and overscan to 10…12; never animate virtualizer translate positions or row heights.

### Album and playlist detail

At 1440×900 with sidebar expanded, the detail page has 1112px usable width after padding. Header uses 280px artwork, 40px gap, and flexible metadata. At 1280×800 use 248px artwork and 32px gap. Art radius 28px. Align metadata to the lower edge of the cover rather than vertically centering a sparse header. Put a small Album / Playlist label above the title; use display typography, artist/creator below at 18px, then wrapped 28px metadata chips with 8px gap.

Chips show available genre, year, track count, and total known duration. Album genre comes from fetched tracks because `LibraryAlbum` has no genre field. Missing year/genre chips disappear. Never substitute invented metadata. A local playlist says `Local playlist`; it does not imply provider sync.

Actions sit 24px below metadata: circular Shuffle 48px, accent Play pill 128×48px with icon and label, circular Add to queue 48px, then a quiet overflow action for Pin and playlist operations. Add appends tracks to the queue; Pin and Add to playlist are separately named actions. C supplies `session.playCollection(tracks, { origin, shuffle })` for B. It awaits `setQueue` with autoplay false, explicit `setShuffle`, then `play`, stopping on failure. Shuffle requests true; Play requests false. Do not blindly toggle the existing queue's shuffle flag. An empty collection disables Play, Shuffle, and Add to queue.

At detail container width below 760px, art becomes 180px and the gap 24px. Below 600px use a stacked header with 160px art, left-aligned metadata, 32px title, and wrapping chips. At short heights the header can scroll normally; never reserve a fixed hero height that hides all tracks. Track list begins 32px after actions with a quiet column header. Use the shared track cards without repeating album art on each album track if space is tight. Multiple discs get a small section label and stable row indices.

Playlist artwork uses its explicit art if present, otherwise a 2×2 composition of the first four available track covers. Missing cells use warm neutral note tiles. Header composition and fallback are deterministic. Local playlist creation is a small dialog with a name field, Create, and Cancel; empty playlists explain Add tracks from your library. Rename/delete live in the detail overflow menu, with a confirmation only for deleting a nonempty playlist.

### Sources

Retain `SourcesView.tsx` provider search and capability logic. Use the normal 36px page heading, 24px gap to the search panel, and route cards below. Search is a 44px pill with source selector adjacent; move selector below at <700px available width. Results use the shared track card treatment, with provider name always discoverable. Search, loading, unauthenticated, failed, empty, and unavailable states occupy the same result area; an error offers only actions supported by that route.

Route cards use a flat 20px-radius panel with 20px padding, minimum width 280px, 20px grid gap. Provider name and state lead. Capabilities and technical details stay here and in Settings, with an optional playback Details popover. Keep actual negotiated fidelity and exclusive-output reporting. Do not invent PCM reactive behavior for provider-engine routes. Preserve the current 350ms provider-search debounce and correct stale-result sequencing when clearing a query or changing route.

### Queue, settings, and toasts

Queue opens as an overlay within the browsing content area, 360px wide, 16px from the right and below the top bar, with bottom edge 16px above the player. It never covers the player or resizes the browsing list during animation. Header is 56px; content scrolls. Queue slots are 64px with 60px rounded cards, 40px art, title/artist, duration, and overflow. Preserve queue occurrence IDs, shuffle order, provider ownership labels, drag reorder, and keyboard Move up / Move down / Remove. Use static glyphs when paused; the existing looping equalizer must not imply playback while paused.

In a content column below 800px, queue becomes a modal panel of width `min(360px, available - 32px)` above the player, with a scrim, focus trap, Escape, and focus return. Closed panels must be unmounted or inert immediately, not just `aria-hidden`. In immersive mode, queue replaces the right-side lyrics card; it does not cover the artwork or create a second right panel. Desktop nonmodal queue has its own close button and remains keyboard reachable.

Settings becomes a 400px-wide modal dialog, max width `calc(100% - 32px)`, max height `calc(100% - 48px)`, radius 28px, 24px padding, anchored visually near the bottom-left settings trigger but centered at narrow sizes. Preserve fidelity switch, eight-band EQ, output picker, route support reasons, and defaults. Add Appearance controls for System reduced motion / Reduce motion, Opaque panels, and optional Readable lyrics. System reduced motion always wins. Modal focus is trapped; Escape and backdrop close restore the trigger. Move the existing internal open state to a controlled prop so a shell-level overlay can own the dialog placement.

Toasts stack at the right, 16px above the player, max width 360px, 14px radius. In immersive mode they use the immersive player's geometry. Keep the existing approximately 6.5s timeout; pause it on hover/focus, retain dismiss, and do not auto-dismiss actionable failures before their action can be used. Queue and modal positions must not block a toast's close control. Use one polite live region and no duplicate nested status announcements. Playback errors also persist in the player Details/error area after the toast expires.

### Immersive Now Playing and synchronized lyrics

Treat full-screen Now Playing as an app-viewport overlay. It does not require the OS fullscreen API. It covers sidebar and top bar, uses the playing artwork's palette, and provides a 44px close/back control at top left and queue/lyrics toggles at top right. Opening and closing restores the browsing route, query, list scroll, and focus. A separate OS fullscreen command may be offered later.

At 1440×900, use 64px side gutters, 64px top clearance, and 152px bottom clearance. Main grid is approximately 52% artwork / 48% lyric card with a 56px gap after accounting for gutters. Art is at most 520px square, vertically centered, radius 28px. Under it, 16px gap to title at 24px/30px and artist at 16px/22px. At 1280×800 use 48px gutters, 40px gap, art ≤480px. Artwork stays still; energy lives in the background.

Right card has radius 28px, 32px padding, 32px backdrop blur, `--lyrics-glass`, and float shadow. It fills available central height, capped at 600px. Header says `Lyrics` with a small `Synced` label only when timestamped lines exist. Text aligns left and can show one prior line, active line, and two upcoming lines. Use 36px/46px bold type, 20px spacing between lyric blocks, and enough trailing scroll padding to center the last line.

Active lyric is `--text`, unblurred. Previous line uses `--text-dim` at .7 opacity, no blur. Next line uses `--text-dim` at .65 opacity and 1px blur; later lines use .45 opacity and 2px blur, capped at two visibly blurred upcoming blocks. This is decorative context, never the only readable access to the lyrics. A Readable lyrics toggle removes blur and sets all inactive text to `--text-dim` at full opacity; enable it automatically for reduced motion and increased contrast. Keep text in the DOM, selectable, with active-line semantics; do not announce every time tick with `aria-live`.

Parse `track.lyrics` as LRC when timestamps are present. Handle multiple timestamps per line, offset tags, blank instrumental spans, duplicate times, CRLF, and malformed lines. Sort timestamp groups stably and activate the latest group at or before `positionNow()`. Seek recomputes immediately, including backward seeks. Plain lyrics get readable static text with no Synced label or fake highlight. Missing lyrics say `Lyrics aren't available for this track` and show title/artist, with no disabled-looking wall of placeholder lines.

Use the existing interpolated runtime clock, sampled at 20Hz in a lyric-local effect, and update React state only when the active group changes. A line with a timestamp can be a seek button when the route permits seek; otherwise it is text with no false pointer affordance. Smooth follow moves the lyric strip with transform, not repeated layout-changing scrolling. Manual wheel/touch/keyboard browsing pauses follow; offer a visible `Follow lyrics` button instead of snapping back on a timer. A direct seek or Follow resumes it. Keep accessible keyboard navigation independent of decorative transforms.

At viewport widths <1000px, use 24px gutters, a 24px gap, art ≤280px, and lyrics ≥320px where they fit. Below 900px, or heights below 600px, replace large artwork with a 56px artwork/title summary above the lyric card; let lyrics fill the remaining height above the compact player. The Lyrics toggle can switch to an artwork-focused layout with a centered cover when desired. This keeps 720×480 usable without microscopic lyrics. With no current track, show the ordinary empty listening state and an Open library action.

## Artwork-derived color and WebGL strategy

### Extraction and ownership

Use one extraction implementation in `palette.ts` and one hook `visuals/useArtworkPalette.ts`. The browse page supplies its selected album/playlist artwork URL; immersive mode and the player use `snapshot.current.track.artwork.url`. Browsing another album never recolors the player metadata or changes playing-track state. Home, generic library, and Sources use the default warm neutral atmosphere.

Sample a decoded image at 48×48. Ignore alpha <.5. Build quantized color buckets weighted by pixel population, then rank by population with a restrained midtone/chroma preference. Convert candidates to OKLCH with a small tested local utility, discard near-duplicate candidates, and choose up to three colors. Include neutral gray/brown candidates so monochrome art stays monochrome. Do not select three isolated saturated pixels from otherwise black or white artwork.

For ambient colors, clamp lightness to .18….38 and chroma to at most .10 while keeping hue. Gamut-map by reducing chroma, never by wrapping RGB channels. If fewer than three colors exist, derive darker shades of the dominant color. No art or decode failure uses RGB `[67, 47, 41]`, `[35, 33, 39]`, `[18, 18, 22]`. Keep extraction output and display-ambient colors distinct so a palette fixture can be inspected independently.

Cache 128 palette promises using URL plus a revision when available; evict oldest entries. Cancel or ignore stale results on rapid navigation and decode failure. Retry only after a URL/revision change. Local `cadence-art://` and data URLs should work. For external art, request anonymous CORS only for origins that support it; catch tainted-canvas reads and fall back immediately. Never weaken Electron security or introduce renderer file reads for color extraction.

Paint the CSS gradient on the first frame, before Pixi finishes initializing. Keep this fallback underneath the canvas throughout its lifetime. Three radial gradients anchor near 18%/14%, 78%/36%, and 45%/90%, with broad 50…85% falloff, plus a `#0c0c0e` base. Overlay a black scrim of .42 at the header increasing to .80 at the track region. Sidebar and player have their own fixed material. Validate the worst-case white/yellow artwork, not only dark covers.

### Scene behavior

Expose `AmbientBackground({ artworkUrl, mode })`, with `mode: 'browse' | 'immersive'`; retain `PixiBackground.tsx` as its renderer implementation. Browse mode has a static artwork gradient and no FFT. Immersive mode may drift and react to real PCM. Only one Pixi Application/canvas may exist at a time. Opening immersive mode suspends the browse backdrop; it must not keep a hidden second renderer running.

Use a full-screen triangle and the existing WebGL2 `#version 300 es` shader. Retain packed `vec4 uBands[12]`. Explicitly request/verify WebGL2 support; initialization or shader failure uses the CSS gradient. Do not silently depend on WebGL1 compiling the shader. Render at resolution `min(devicePixelRatio, 1.0)` initially, step down to .75 then .5 after sustained frame overruns. Measure cost against the chosen frame cap, not a hard-coded 60fps delta threshold. A soft background can lose resolution before UI responsiveness.

Use a 30fps background ticker; DOM interactions remain at display refresh rate. Drift period is 24 seconds, with spatial displacement ≤3% of viewport. Do not simulate beat-synced motion when a route reports `visuals.kind === 'ambient'`; an optional slow drift is enough. Paused playback settles reactives to zero and stops drift within 300ms; loading, buffering, hidden window, and reduced motion do not continue a decorative loop. Resume without integrating time spent hidden.

### FFT contract and visual limits

`session.runtime.fft.bands` stores **48 raw dBFS values**, each within -100…0; peak remains linear 0…1. Initialize bands to -100, not 0. Existing Rust `services/audio/src/fft.rs` establishes these units. Correct `MockCadenceApi` to emit `20 * log10(max(amplitude, 0.00001))`; keep its peak linear. Do not auto-detect units from numeric signs.

Normalize at one visual adapter in `visuals/fft.ts`: `level = clamp((db + 72) / 72, 0, 1)`. This is display energy, not a claim of physical amplitude. Non-finite or missing bins are silent. Keep a reusable 48-element buffer; allocate nothing per frame. Envelope each band with time-based attack 80ms and release 280ms using `1 - exp(-dt / tau)`. Group approximate low/mid/high display energy as bins 0…15, 16…31, and 32…47.

FFT is valid only for the current lease generation, a PCM-FFT route, playing status, and a frame received within 500ms. A generation change immediately zeros the visual envelope. Stale data releases to zero; it never turns into fabricated spectrum. Runtime band writes remain outside Zustand updates. Shader uniforms read these values directly.

Low energy changes one background lobe's size by at most 2%; mid energy changes gradient mixing by at most .035; high energy raises local luminance by at most .025. Render the already-darkened ambient palette directly with bounded modulation; replace the old shader's additional `lum = .05 + ...` multiplier, which would crush these clamped colors to black. Match its resting appearance to the CSS fallback. Clamp final reactive brightness and keep dark scrims stable. No artwork scale breathing, player size pulse, lyric pulse, strobe, or radial spectrum drawn over text. A small optional 48-band spectrum belongs behind the artwork only, maximum height 24px, and is hidden in browse mode.

Use seconds for shader time: increment by `deltaMS / 1000`, then derive the 24-second phase. Cap delta after pauses. Palette transitions take 700ms from the currently displayed palette, with smooth interpolation in OKLab or linear-light RGB; a second track change retargets the current interpolation. Do not interpolate gamma-encoded CSS color strings in a per-frame React render.

### Reduced motion, failure, and capture

Effective reduced motion is OS preference OR the in-app Reduce motion setting. It prevents Pixi initialization entirely, stops existing tickers/rAF artwork effects, uses static gradients, removes all spatial UI transitions, and disables lyric blur/follow animation. Position, timers, actual playback feedback, and lyric activation still update. Color/opacity feedback may take at most 80ms. No global 1ms override as a substitute for stopping loops.

On WebGL context loss, reveal the already-painted fallback immediately and destroy resources cleanly. Do not wait for a restoration event on a canvas the component has destroyed. Retry once through a new renderer when the scene remounts or the user explicitly retries; repeated failures stay static. Async init/unmount must clean up partially created Applications as well as fully attached canvases. StrictMode must not leak canvases or listeners.

For screenshot mode add `?cadence_capture=1` alongside existing `?cadence_mock=1`. This opt-in mode fixes palette interpolation, shader phase, grain seed, mock playhead, and FFT frame; it does not imply reduced motion or change visual materials. Provide separate reduced-motion and forced-WebGL-failure fixtures. Wait for fonts, visible image decodes, extraction completion, renderer readiness or declared fallback, and a rendered frame before capture. Expose `data-visual-ready="true"` after those conditions so capture scripts can wait on evidence rather than only fixed sleeps.

## Motion specification

Cadence motion confirms actions and preserves spatial context. Frequent browsing and keyboard navigation stay immediate. CSS transitions handle interactive states; use WAAPI only where interruption requires explicit cancellation. Add no Motion dependency. No mount animation for normal page content, rows, or default icon state. No `transition: all` and no perpetual `will-change` on artwork.

| Token | Value |
| --- | --- |
| `--ease-out` | `cubic-bezier(.23, 1, .32, 1)` |
| `--ease-panel` | `cubic-bezier(.32, .72, 0, 1)` |
| `--ease-swap` | `cubic-bezier(.2, 0, 0, 1)` |
| `--ease-color` | `cubic-bezier(.25, .1, .25, 1)` |
| `--ease-field` | `cubic-bezier(.4, 0, .2, 1)` |

| Element / trigger | Enter or change | Exit / interruption | Reduced motion |
| --- | --- | --- | --- |
| Button pointer press | transform scale 1→.96, 100ms ease-out; release 120ms | Retarget from current transform; static controls opt out | No scale, immediate tint |
| Row, card, icon hover | background-color/opacity, 100ms ease-color; no translation | 80ms ease-color | 0…80ms color only |
| Sidebar selection / center segmented selection | Static filled capsule changes immediately; color 100ms | No sliding capsule on routine navigation | Immediate |
| Sidebar collapse or section expansion | Immediate layout change | No width/height interpolation | Immediate |
| Page/filter/search result change | Immediate; preserve scroll where appropriate | Ignore obsolete requests | Immediate |
| Play/pause glyph | 120ms opacity crossfade ease-swap, stable outer dimensions | Retarget, no spin or bounce | Immediate glyph swap |
| Favorite state from pointer | Contextual inner glyph scale .25→1, opacity 0→1, blur 4→0px, 160ms ease-swap | Two overlaid glyphs retarget; the button shell stays at ≥.96 | Immediate filled/outline swap |
| Seek/volume pointer input | Native thumb and fill track pointer without easing | Pointer cancel restores last confirmed position | Same direct feedback |
| Playback progress | transform scaleX based on runtime clock, linear, no CSS lag | Seek snaps to target; time labels update only when their value changes | Same accurate progress |
| Shelf arrow | Scroll 220ms ease-out | Wheel, touch, second arrow, or key cancels current scroll | Immediate scroll |
| Tooltip | 500ms first hover delay, opacity 100ms | Exit 60ms; nearby tooltip opens instantly | Immediate on focus; no movement |
| Menu / small popover | opacity + scale .98→1, 160ms ease-out, origin at trigger | opacity + 4px vertical exit, 100ms ease-out | Opacity ≤80ms |
| Queue overlay | opacity + translateX 16px→0, 220ms ease-panel | Opacity + translateX 8px, 140ms ease-out; mark inert immediately | Immediate placement, opacity ≤80ms |
| Settings/create-playlist modal | opacity + translateY 8px→0, 220ms ease-panel; scrim 160ms | opacity + translateY 4px, 140ms ease-out | Opacity ≤80ms |
| Immersive open/close | overlay opacity + translateY 8px→0, 260ms ease-panel | opacity + translateY 4px, 180ms ease-out; preserve underlying view | Opacity ≤80ms |
| Player browse/immersive variant | One component changes placement instantly; inner content opacity 120ms | No full-window flying thumbnail or width tween | Immediate |
| Artwork replacement | opacity 220ms ease-out after decode; fixed frame and radius | Retarget from displayed image; no zoom | Opacity ≤80ms |
| Active lyric group | color/opacity 160ms ease-color; strip transform 240ms ease-out | Seek/line click snaps, repeated group change retargets | No strip animation or blur |
| Toast | opacity + translateY 8px→0, 180ms ease-out | opacity + translateY 4px, 120ms ease-out | Opacity ≤80ms |
| Artwork atmosphere palette | 700ms ease-field, uniform interpolation | Retarget displayed colors | Static palette, optional ≤80ms fade |
| Ambient drift / FFT | 24s drift; 80ms attack / 280ms release envelopes | Pause settles ≤300ms, hidden stops | No renderer or decorative loop |

All durations describe the longest property on that element. UI transitions stay below 300ms; the atmosphere is the deliberate exception. Spatial transformations belong to isolated wrappers, never virtualizer positioning nodes. The favorite glyph's tiny scale is an internal icon swap, not a panel opening from nothing. Gate hover behavior with `(hover: hover) and (pointer: fine)`.

Keyboard-initiated UI actions skip their interaction transitions, including menus, navigation, panel opening, focus changes, and seeks. Scope an input-modality flag to the affected transition rather than globally disabling the background on every keypress. Keyboard focus rings appear immediately. System-driven lyric updates still obey the user's effective motion preference. Every animated state also has a static label, fill, or glyph.

## Floating player bar contract

### Geometry and composition

Mount exactly one `PlayerBar` outside the routed main view. It stays mounted while browsing and while immersive mode opens. `PlayerBar` is the only owner of playback seek/transport UI. `NowPlaying` must not mount a second `Transport` or `SeekBar`.

Browse placement: left and right 16px within the content column, bottom 16px, maximum width 1184px centered when space exceeds it, height 96px, radius 28px, 16px padding, `--glass`, blur 24px, `--shadow-float`. Reserve `--player-reserve: 128px` at the end of all browsing scroll containers. It may overlay an atmosphere, never the last reachable track row.

At bar width ≥980px, columns are `minmax(200px, 1fr) minmax(360px, 1.55fr) minmax(136px, .65fr)` with 24px gaps. Left holds a 56px cover, title/artist stack, and 40px love target. Center has shuffle / previous / 44px Play-Pause / next / repeat above a scrubber with times. Right holds volume, queue toggle, and overflow for Playback details. Artwork and metadata open immersive mode through one real button; the heart is a sibling button. The bottom play button is warm white with dark ink so the persistent bar does not compete with the detail page's accent Play pill.

At bar widths below 980px, use height 112px, 12px padding, 48px art, two rows. First row is flexible metadata + love and a 136px previous/play/next group; second row is the full-width scrubber with times and a trailing 40px overflow trigger. Volume, shuffle, repeat, and queue remain available through that overflow; queue is also in the top bar. Do not shrink hit targets or hide the seek bar. Reserve 144px of scroll clearance. At the 720px minimum window, the 72px rail leaves a 616px bar, which fits this layout.

Immersive placement: same mounted component gets `variant="immersive"`, centered in the full viewport, max width 1040px, bottom 24px, radius 36px. Use the same width-based compact rule and reserve bar height + 48px in the immersive layout. Full-size variant keeps all controls; compact puts secondary controls into overflow. No duplicated media session or keyboard listeners.

### Component interface and state

Freeze these interfaces in `apps/ui/src/ui/contracts.ts` before parallel work. Existing protocol types stay authoritative for track, snapshot, route, and queue data.

```ts
type PlayerBarProps = {
  variant: 'browse' | 'immersive';
  onOpenNowPlaying: () => void;
  onOpenPlaybackDetails: () => void;
};

type NowPlayingProps = {
  lyricsOpen: boolean;
  onClose: () => void;
  onLyricsOpenChange: (open: boolean) => void;
  queuePanel: React.ReactNode;
};

type SettingsSheetProps = {
  open: boolean;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
};
```

`PlayerBar` reads narrow Zustand selectors from the existing session. Playback commands still go through `session.*`; navigation and favorites use their separate UI stores. Keep `positionNow()` and FFT runtime outside component-wide selectors. Extract global playback keys from `App.tsx` into a hook mounted once by App. Inputs, contenteditable regions, menus, dialogs, and native slider keys retain their own keyboard handling. Dispatch no playback shortcut after an event has been prevented by a descendant.

| State | Required bar behavior |
| --- | --- |
| No current track | Keep bar geometry, show neutral cover and `Choose something to play`; disable seek/love/skip, expose Open library through metadata. Play may start an existing queue only if the session can do so. |
| Loading | Keep decoded art/metadata frame stable; show `Loading` and a small status indicator, prevent duplicate Play submissions. |
| Buffering | Keep elapsed time at confirmed clock position; show `Buffering`; no false FFT response. Pause follows real route support. |
| Playing | Pause glyph, runtime-interpolated progress, current capability gates. |
| Paused | Play glyph, stable elapsed time and stopped visual energy. |
| Stopped with a current track | Keep artwork/metadata, show Play, reflect the actual stopped position. |
| Error | Keep the current title and a persistent error affordance; Details contains the actual message and valid retry/sign-in action. |
| Unknown/zero duration or cannot seek | Show `Live` only if a route actually identifies live playback; otherwise `--:--`, disabled seek, and a reason. Never invent a duration. |
| Muted | Mute state is separate from stored volume. Unmute restores the previous volume; moving volume unmutes through the existing session API. |
| Cannot pause/skip | Disable only the unsupported actions with a discoverable reason; keep supported controls active. |

Seek input is a native range with a 28px interaction lane, 4px visible track, 12px thumb, elapsed and total time in reserved-width slots. Pointer scrubbing captures the pointer, previews locally, commits once on release, clamps to duration, and cancels cleanly on pointercancel or a track change. Use the current track-instance/queue ID to reject a commit after a handoff. Arrow/Home/End work natively and commit with no animation. Provide formatted `aria-valuetext`; avoid per-frame live announcements. Fill uses transform scaleX with left origin rather than animated width.

The love button toggles the globally unique `TrackRef.id` in the local collection store and has `aria-pressed`, plus `Add to favorites` / `Remove from favorites` names. It does not imply a provider-side favorite. Volume is a native 0…100 range with at least 28px interaction height; a 4px painted line alone is not a usable target. Queue, repeat-one, and shuffle states retain non-color markers.

Only the shell decides player placement and overlay focus. Opening immersive mode makes the browsing shell inert while keeping the player operable inside the modal focus scope. Use a shared overlay root so one focus trap can include the immersive content and the stable player sibling. Settings/create dialogs temporarily supersede that scope and restore it when closed. Preserve exact DOM identity for the bar during these changes.

## Component and file ownership for four parallel UI workers

Paths below are relative to `apps/ui/src` unless stated otherwise. Proposed files are new. Each file has exactly one owner. Workers may consume another worker's exported contract, but changes to that contract go through its owner. There is no parallel editing of the 1649-line global stylesheet.

### Shared contract and integration rules

Worker A first creates `ui/contracts.ts`, the style import structure, and no-op mount points. Freeze exports before B/C/D build against them. Use a separate Zustand navigation store so adding browse routes does not entangle the playback coordinator:

```ts
type BrowseRoute =
  | { kind: 'home' }
  | { kind: 'library'; section: 'albums' | 'artists' | 'tracks' | 'favorites'; query: string }
  | { kind: 'album'; album: LibraryAlbum }
  | { kind: 'artist'; name: string }
  | { kind: 'playlist'; id: string }
  | { kind: 'sources'; route?: RouteId };

// navigation.ts, Worker A
// route, history/index, sidebarExpanded, nowPlayingOpen, lyricsOpen, settingsOpen
// navigate(route), back(), forward(), openNowPlaying({ lyricsOpen? }), closeNowPlaying()
// Route transitions preserve saved scroll/query state keyed by route identity.

// collectionStore.ts, Worker B
type PlaylistEntry = { occurrenceId: string; track: TrackRef };
type LocalPlaylist = { id: string; name: string; entries: PlaylistEntry[]; createdAt: number };
type Pin = { kind: 'album'; album: LibraryAlbum } | { kind: 'playlist'; id: string };
// favorites: Record<TrackRef['id'], TrackRef>
// playlists: LocalPlaylist[]; pins: Pin[]
// toggleFavorite(track), createPlaylist(name), renamePlaylist(id, name),
// deletePlaylist(id), addTracks(id, tracks), removeTrack(id, occurrenceId), togglePin(pin)
```

Playlist storage gives every track occurrence its own ID, like queue items; duplicate songs are valid. Expose display tracks through a selector while edit actions use occurrence IDs. Resolve stale local track records through `api.library.track(id)` before playback and mark missing entries unavailable. Provider references keep their route and availability semantics. Version the data as `cadence.collections.v1`; validate reads and survive storage failures with an in-memory store and a visible save warning. Reuse the same favorites/pins across Library, sidebar, detail, and player. No cloud sync claim.

Worker A owns `ui/preferences.ts` and `cadence.preferences.v2` for sidebar section disclosure, reduced-motion override, opaque materials, and readable lyrics. Transient route/overlay history stays in memory. Worker C owns playback session changes; B never stores playback truth and D never writes per-frame values into Zustand. Remove or bridge legacy `UiState.view/setView` and `palette/setPalette` only through C after A/D callers migrate; maintain buildable exports during the handoff.

### Ownership map

| Worker | Existing files owned | New files owned | Deliverable and dependency |
| --- | --- | --- | --- |
| A: foundation, shell, integration | `App.tsx`, `styles.css`, `main.tsx`, `icons.tsx`, `api.ts`, `mock/data.ts`, `mock/MockCadenceApi.ts`, `__tests__/mock.test.ts`; repo `scripts/screenshot.sh`, `apps/desktop/scripts/capture.cjs` | `ui/contracts.ts`, `ui/navigation.ts`, `ui/preferences.ts`, `components/AppShell.tsx`, `components/Sidebar.tsx`, `components/TopBar.tsx`, `ui/IconButton.tsx`, `ui/PillGroup.tsx`, `ui/Modal.tsx`, `ui/Menu.tsx`, `styles/tokens.css`, `styles/base.css`, `styles/shell.css`; repo `apps/ui/public/textures/grain.png` | Tokens, accessible shared controls, navigation/history, overlay/focus placement, app composition, fixtures and capture readiness. Publishes contracts first; imports other workers' views and controls. |
| B: browse and collection | `components/LibraryView.tsx`, `components/SourcesView.tsx`, `components/RouteBadge.tsx` | `collectionStore.ts`, `components/HomeView.tsx`, `components/AlbumView.tsx`, `components/PlaylistView.tsx`, `components/ArtistView.tsx`, `components/ArtworkCard.tsx`, `components/TrackList.tsx`, `components/PlaylistDialog.tsx`, `useLibraryQuery.ts`, `styles/browse.css`, `styles/sources.css`, `__tests__/collectionStore.test.ts` | Shelves, detail pages, responsive track cards, search/pagination, favorites/pins/local playlists. Consumes A routes and shared controls, existing API/session commands, and D's palette hook. |
| C: persistent playback and utility overlays | `store.ts`, `hooks.ts`, `components/Transport.tsx`, `components/SeekBar.tsx`, `components/QueuePanel.tsx`, `components/SettingsSheet.tsx`, `components/CapabilityChips.tsx`, `components/Toasts.tsx`, `__tests__/store.test.ts` | `components/PlayerBar.tsx`, `components/PlaybackDetails.tsx`, `styles/player.css`, `styles/overlays.css` | One persistent bar, pointer/keyboard seek, transport/capability gating, queue modes, settings, toast collision handling, single shortcut hook. Consumes A modal/menu, B favorites selector, D's artwork palette if needed for a static thumbnail tint. |
| D: atmosphere and immersive listening | `palette.ts`, `visuals/PixiBackground.tsx`, `visuals/shader.ts`, `components/NowPlaying.tsx` | `visuals/AmbientBackground.tsx`, `visuals/useArtworkPalette.ts`, `visuals/color.ts`, `visuals/fft.ts`, `components/LyricsPanel.tsx`, `lyrics/parseLrc.ts`, `styles/now-playing.css`, `__tests__/palette.test.ts`, `__tests__/lyrics.test.ts`, `__tests__/fft.test.ts` | Artwork color pipeline, explicit WebGL2/fallback lifecycle, bounded FFT response, immersive layout and honest synced/plain/missing lyric modes. Consumes runtime from C and shared preferences from A. |

`styles.css` becomes imports only, in this order: tokens, base, shell, browse, sources, player, now-playing, overlays. Each worker moves their legacy selector rules into their owned file and uses a root namespace such as `.cd-shell`, `.cd-browse`, `.cd-player`, `.cd-now`, `.cd-queue`. A deletes the migrated legacy rules after all views are wired; no permanent v2 override pile. Shared base owns focus, native range baseline, scrollbar rules, and motion preference helpers. Worker-specific classes cannot redefine global tokens.

Freeze these additional exports: B exports `HomeView`, `LibraryView({ section, query })`, `AlbumView({ album })`, `ArtistView({ name })`, `PlaylistView({ id })`, `SourcesView({ route? })`, `useCollections`, and collection actions. C exports `PlayerBar`, `QueuePanel({ mode: 'browse' | 'immersive', onClose })`, controlled `SettingsSheet`, `PlaybackDetails`, and `usePlaybackKeys`. D exports `NowPlaying` with the contract above, `AmbientBackground`, and `useArtworkPalette(artworkUrl)`. A controls visibility and passes C's queue node into D's immersive card slot. D never imports the shell or player, avoiding circular ownership.

For detail backgrounds, A derives artwork from its album route or B's playlist selector and passes the URL to `AmbientBackground` in browse mode. Generic views pass no artwork. D's immersive view owns the immersive renderer. A unmounts the browse background while immersive is open. A keeps the browse DOM and scroll containers mounted and inert, hides their content from accessibility, and restores them on close.

Cross-owner changes use explicit handoffs: D gives A the mock dBFS formula and capture-frame needs; C gives A the keyboard-hook replacement and bar placement requirements; B gives A sidebar collection selectors. No worker edits `packages/protocol`, Electron IPC, Rust playback, or dependency manifests for this visual pass. A may alter only the desktop capture helper, not runtime Electron window policy.

### Implementation sequence

1. A publishes tokens, shared components, route/player contracts, preferences, CSS imports, and placeholder mounts. Capture the existing UI for comparison before replacing styles.
2. B builds Home/library/details and the collection store; C extracts the persistent player and utility panels; D builds color extraction, fallback, immersive layout, and LRC handling. Each uses its own files and neutral placeholder data until dependencies land.
3. Integrate existing endpoints before fixtures. A replaces old TopBar and view switching, mounts the stable player, wires backgrounds and overlay focus. C migrates legacy session view/palette callers. B verifies folder scans and real album filters. D supplies deterministic readiness. A changes mock FFT to dBFS and adds missing visual fixtures.
4. Run UI typecheck/tests/build, capture all target layouts, inspect states, then fix integration issues within the owning files. Keep the final check focused on playback continuity, visual hierarchy, reduced motion, and the 720×480 minimum.

## Verification and acceptance

This planning pass does not claim rendered verification. Implementation must produce proof using the existing headless Electron capture path. Any app development server must run through `portless`, per the workspace instruction. Do not copy the raw Vite-server launch from the existing screenshot script; update the wrapper to accept the Portless URL, pass it through to `capture.cjs`, and forward width/height arguments. A built static UI may also be loaded through an appropriate file/custom-scheme capture path with relative assets; keep mock opt-in explicit.

Run `pnpm --filter @cadence/ui typecheck`, `pnpm --filter @cadence/ui test`, and `pnpm --filter @cadence/ui build` after implementation. Add meaningful unit coverage for LRC timing/offsets/backward seeks, palette failure/monochrome art, dBFS normalization and stale generations, collection persistence and duplicate playlist occurrences. Preserve the existing queue/store tests. Do not write tests that merely assert token strings or copy stylesheet values.

| Capture group | Required evidence |
| --- | --- |
| 1440×900, standard | Home with multiple shelves, album detail with warm art, playlist detail, Library tracks, Sources, immersive synced lyrics, queue open, Settings open |
| 1280×800, standard | Default shell with expanded sidebar, detail page plus player, immersive lyrics with readable controls |
| 720×480 | Rail, compact player, narrow detail, queue modal, compact immersive lyrics; last track and all controls reachable |
| Color edge cases | Bright white/yellow cover, saturated blue/green cover, monochrome cover, missing cover, decode failure; stable coral accent and legible metadata |
| Playback states | No track, loading, buffering, playing, paused, unsupported seek, zero duration, error, unavailable route |
| Lyrics states | Synced, plain, missing, malformed LRC, multiple timestamps, backward seek, manual scroll plus Follow, readable mode |
| Fallbacks | Reduced motion with no canvas, forced WebGL2 failure, context loss, opaque panels, runtime preference change |

Store evidence under `docs/design/screens/v2-*.png`. Pin Linux font environment, viewport, DPR, fixture data, mock playhead, and screenshot phase. Capture still WebGL output with a fixed FFT frame to prove the actual shader renders under headless Electron; a fallback-only image does not prove WebGL. Software WebGL2 is acceptable when the headless host has no GPU; record renderer availability and capture the static fallback separately. Confirm `capture.cjs` exits and no renderer loop or server leaks remain.

Acceptance requires: one mounted player and one media-session/shortcut subscription; no playback restart during route changes; no second active canvas; no hidden focusable queue/settings/sidebar children; a visible focus ring on every control; separate selected/playing track states; no overlap between the last row and player; no fake provider capabilities, timestamps, or library ordering; and palette/FFT updates that do not rerender the full React view tree. Inspect panel and glyph transitions at 10% speed, then at normal speed; they must retarget cleanly when toggled rapidly. Check contrast on composited art states and verify keyboard, pointer cancel, and modal focus return in addition to screenshots.
