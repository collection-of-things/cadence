BEFORE 5/10 · AFTER 6.5/10

Round 1 moved the app toward Cider: inset stage card, floating glass bar, heavier album and artist titles, a wash on the playing row instead of a solid bar, a real artist hero, a compact player below 720px, and no more horizontal overflow (the r0 lyrics overflow is fixed). Several seams still give it away.

## Top issues still in AFTER (ranked)

1. Content shows through the gap under the docked player (01, 04, 15, 16, 20, 22, 24: dotted art and row tops at y≈885–892). The bar now sits 10px off the card's bottom edge, and scrolled content shows in that strip as stray slivers on almost every screen. Fix in shell.css: `.stage-main { mask-image: linear-gradient(to top, transparent var(--pb-inset), #000 calc(var(--pb-inset) + 6px)); }`. The bar sits outside .stage-main, so its blur still works.

2. Album and playlist titles are cut off hard under the top bar (10-album-detail-scrolled, frame sheet_01 row 4). `.album-scroll { mask-image: none }` removes the top fade, so the new 46px/760 title slides under the capsules at full opacity. This was already in r0, but the heavier title makes it worse. Fix in home.css: `.album-scroll { mask-image: linear-gradient(to bottom, transparent calc(var(--topbar-h) - 18px), #000 calc(var(--topbar-h) + 8px)); }` (the page wash lives outside the scroller, so the colour is unaffected).

3. The player's now-playing column truncates at mid widths (31/32 at 900px: "Pale Mac…" / "Midnight C…", with about 150px of empty space beside it). The equal `1fr | 240–340 | 1fr` grid starves the left column while the right column holds only icons. Fix in playerbar.css: `@container pill (max-width: 900px) { .playerbar { grid-template-columns: minmax(0,1fr) minmax(200px,300px) auto; } }`. The same applies to 1100px with the rail open.

4. The side panel header doesn't line up with the stage chrome (15, 16, 35). The Lyrics/Up Next segment is centred at y≈72 while the top-bar capsules are centred at y≈32, so the panel reads as a separate window. Fix: put `.side-panel` header row at `top: var(--gap)` with height `var(--topbar-h)` and centre it, so the segment sits on the same row as the search and settings capsules.

5. Corner radii aren't concentric. The bar is 16px inset 10px inside a 14px card, so its corners look rounder than the frame (bottom corners in every 1440 shot). Use `--stage-radius: 20px; --pb-radius: 12px` (or 24/14), since inner radius ≈ outer radius − inset.

6. The Play On menu floats loose (22). `bottom: calc(100% + 36px)` leaves it about 4px above the bar's edge, and it lines up with neither the bar nor the trigger. Use `bottom: calc(100% + 44px)` so it clears the bar by a clear 8px, and set `right: -8px` so its edge lines up with the bar's icon group.

7. The `#` column header is misaligned (04, 14, 32). '#' sits at x=281 while the indices are centred at about 310. Fix in home.css: `.track-head span:first-child { justify-self: center; }`, matching `.tr-index`.

8. The shelf-rail fade never turns off (01, 31, 36). The 36px right mask stays even after scrolling to the end, so the last card is always faded, and there's no left fade once scrolled. Shelf already tracks its prev/next disabled state: add `.shelf-rail.at-end { mask-image: none }` and, when not at the start, a 24px left fade.

9. The page filter field doesn't match the top-bar search (04, 14, 32). It's a flat dark rectangle with no ring under a glass capsule, which looks like two different search fields. Give `.lib-filter` input `border-radius: var(--r-pill); box-shadow: var(--capsule-ring); background: var(--well)` and the same focus ring as `.topbar-search input:focus`.

10. The empty Favourites page (12) shows a "0 TRACKS" chip, a dim salmon Play that looks broken rather than disabled, and a loose left-aligned hint. Hide the count chip at 0, hide shuffle and Play, and use `<EmptyState>` centred like 21-apple-home.

11. Narrow-window playerbar (31): the bar's left edge is at x=74 while the content gutter is at x=88, so they don't align at 900px. Either set `--pb-inset` to match the stage padding at that width (`@container stage (max-width: 900px)`: 14px), or drop the gutter to 24px everywhere below 1100px.

12. Motion. I can only judge it at 2 fps, but it reads well: the page fade plus the 6px rise is single-piece, the now-bars are staggered, and keyboard navigation is instant. Two gaps: (a) opening an album sets `--shell-tint` on the root in a layout effect, so the sidebar and frame tint snap while the page fades in over 200ms. Add `transition: --shell-surface` by registering `@property --shell-tint { syntax:'<color>'; inherits:true; initial-value:#0000 }` and transitioning it over 240ms on `.ambient`/`.sidebar`. (b) Going immersive snaps `.ambient` from inset 8 and radius 14 to 0. Add `border-radius` and `inset` to that transition (`var(--shell-move)`) so Now Playing grows out of the card instead of jumping.

## Made worse / consider reverting

- `.ambient { box-shadow: 0 0 0 100vmax var(--shell-surface) }` repaints a window-sized shadow on every frame of the sidebar or rail slide, because `.ambient` animates left/right. It's fine on fast Macs but is a jank risk. Paint the window surface on `body`/`.app` instead and keep `.ambient` to the card.
- The sidebar lost its warmth. At a 6% tint on 0.135 L it's nearly black on every page (09/11 vs r0), so the album colour no longer reaches the window. Cider keeps it neutral too, so this is acceptable, but 8–10% would keep the r0 character.
- `.app::before` is now a full-width 8px drag strip at z-index 3. It covers the top 4px of the Now Playing corner buttons (17), so clicks there drag the window. Exclude it while `.is-immersive` or shrink it to the stage's span.
- Nothing else needs reverting. The current-row wash, hidden-until-hover row actions (keyboard access is kept via `:focus-within`), and the build test guarding `backdrop-filter` are all clear wins.
