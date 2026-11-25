BEFORE 5/10 · AFTER 7.3/10

Round 2 fixed nearly everything I raised, and the worst-case data holds up: long, unbreakable, CJK and emoji names truncate or wrap cleanly at 1440, 900 and 720, and both audits are empty. One regression is visible, and three r1 items are only partly done.

## Round-1 findings

Resolved:
- #1 Gap under the docked bar (01, 04: the strip is clean).
- #3 Player at mid widths (31: the full title now fits at 900px).
- #4 Side-panel tabs now sit on the top-bar row (15).
- #5 Corner radii are concentric (18 and 12).
- #6 The Play On menu clears the bar by about 12px and lines up (22).
- #8 Shelf fades now depend on scroll position (at-start / at-end).
- #9 The filter fields are capsules that match the top-bar search (04, 08).
- #10 Empty Favourites (26).
- #12a The album tint eases in through `@property --shell-tint`.
- #12b Now Playing now grows out of the card (top/bottom/radius transitions).
- From "made worse": the 100vmax shadow moved to `body`, the sidebar tint is up to 9%, and the drag strip is off while immersive.

Partly resolved:
- #2 The album title fades under the top bar again, but over only 24px. A 46px/760 headline still reads as sliced in half (10, crop of y 40–90).
- #7 The '#' header is now right-aligned at x≈306, while single-digit indices are centred at about 310. Close enough; nit.

Not resolved:
- #11 At 900px and below, the bar's left edge is at x=74 while the content gutter is at x=88 (31, 33, 45).

## Remaining issues, ranked

1. **Regression: the row menu's glass no longer blurs.** Times and ⋯ glyphs from the rows below show through crisply. In 25, "5:30" and "4:40" read through "Play next" and "Add to queue". In 06 the r2 crop shows "4:01" through the menu, and the r1 crop does not. At 0.9 alpha a 56px blur should erase that text, so `backdrop-filter` isn't being applied. The likely cause is this round's `.stage-main { mask-image }`: a mask makes `.stage-main` a backdrop root, and Chromium composites the menu without its backdrop inside a masked, rounded, overflow-clipped layer. Fix:
   - Confirm by turning off that mask in DevTools.
   - Then clear the strip under the bar without a mask on an ancestor of popovers. For example, move the mask to `.stage-scroll` and the other page scrollers by appending a bottom stop to their existing gradients. `.stage-scroll` already has a top mask, so this adds no new backdrop root above the menu, which lives inside the scroller.
   - As a safety net, use `.menu { background: var(--sheen), oklch(0.2 0.007 285 / 0.97) }` so text can never bleed through.
   - Check the floating side panel (38) and the top-bar capsules for the same problem.

2. **Regression: a one-word orphan in Now Playing lyrics** (17, 44: "Every window hums a different / tune"). In r1 the line fit on one line. The new `padding-right: 6%` pushes it to wrap. Fix in lyrics.css: `.npf-lyrics .lyrics-scroll p { text-wrap: pretty; padding-right: 4.5%; }`. A 1.04 scale from the left edge grows the line by 4% of its own width, so 4.5% is enough room.

3. **#11, still open: the bar and gutter don't align at narrow widths.** Use `@container stage (max-width: 820px) { :root { --pb-inset: 14px } }`, or put the `.stage-scroll` padding at 24px → 10px + 14px of bar padding, so the left edge of the art sits at the same x as the page title. The art is at x=92 and the title at x=88, so the bar's inner edge already nearly matches. The outer edge is the step the eye catches.

4. **The floating side panel (≤1000px) cuts its list off hard** (37: the "Slow Cartography Interl…" row is sliced at the card's bottom edge). Give it the same fade as every other scroller: `.lyrics-rail .side-panel-body > :is(.q-list, .q-scroll) { mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent) }`. Use the actual queue scroller selector. Nit: a 10px strip of shelf art shows between the card and the stage edge (38, x≈883–890). `right: calc(var(--gap) + 6px)` plus a 1px ring makes that read as intentional.

5. **The album title fade is too short** (10, frames sheet_01 row 4). Make the fade on `.album-scroll` only longer: `mask-image: linear-gradient(to bottom, transparent calc(var(--topbar-h) - 24px), #000 calc(var(--topbar-h) + 28px))`.

6. **Now Playing keeps the bar indented 245px with nothing beside it** (17, 44). This hasn't changed since r1, and keeping it still during the open is deliberate. Once the view has settled, though, the empty strip makes the bar look off-centre against the full-bleed field. Option: when `.npf:not(.has-nav)` is set, ease `left` to `var(--pb-inset)` over `var(--shell-move)` with a 120ms delay, after the field has grown.

7. **Copy and data consistency (nit, 08, 09, 47):**
   - The Artists page header says "10 albums · 79 songs", and its filter says "Search title, artist, album". Use "10 artists" and "Search artists".
   - The same count is "7 TRACKS" on the album, "7 songs" on the artist page and "7 tracks" in the artist rows. Pick "songs" everywhere, as the Songs page does.

8. **The ⋯ button now shows at 0.35 on every row** (04, 41). That adds a dotted column of noise to the list. Apple Music and Cider show it on row hover, focus or menu-open only. Since hover devices already get the hover reveal, use 0.18 (or 0) at rest. Nit.

9. **The shelf edge fades snap on and off** after the first pixel of scroll. Register `--fade-l` and `--fade-r` with `@property` (syntax `<length>`) and transition them over 160ms. Nit.

10. **Empty Favourites (26).** The hero title is bottom-aligned, so "Favourite Songs" plus a one-line lede sits low beside a 320px saturated tile with a black star, the loudest element on the page. Use `.album-hero:has(.album-lede) { align-items: center }` and a 22% lighter star (`--acc-ink` at 0.85 alpha). Nit.

## Motion

I can only judge at 2 fps, and nothing looks wrong:
- Pages still arrive in one piece, now at 160ms with a 4px rise.
- The tint eases back to neutral on Home (sheet_02, row 3).
- The side panel slides in under the tabs.
- The bar no longer jumps on Now Playing.

I can't confirm the grow-from-card at this frame rate, so a 60fps capture of entering Now Playing should be checked before shipping.

To reach 8+, fix #1 and #2 (both regressions), then #3–5.
