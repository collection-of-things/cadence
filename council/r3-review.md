BEFORE 5/10 · AFTER 8.2/10

Round 3 fixed both regressions from round 2 and most of the polish list. What still keeps this below 9 is motion: two transitions don't come together cleanly when played at quarter speed.

## Round-2 findings

Resolved:
- **#1 The row-menu glass blurs again.** In crops of 25 and 06, "5:30" and "4:40" are soft ghosts behind "Play next" and "Add to queue". The masks moved to the scrollers (`--fade-both`).
- **#2 The lyrics orphan is gone.** In 17 and 44, "Every window hums a different tune" is on one line, and both neighbours of the sung line are sharp.
- **#4 The queue fades out at the bottom of the floating panel** (37).
- **#5 The album title fade.** In 10, the headline now dissolves under the bar instead of being sliced.
- **#6 Now Playing bar.** In 17 the bar spans the window evenly. At quarter speed it starts in the docked slot and widens smoothly.
- **#8 The ⋯ column** sits at 0.2 at rest.
- **#9 The shelf fades** are eased through `@property`.

Partly resolved:
- **#7 Wording.** "songs" is used on the album, artist and favourites pages, but these still differ:
  - The queue header says "8 tracks" (39, 37: `QueuePanel.tsx:128`).
  - The album toolbar uses "Filter tracks" and "No tracks match." (`TrackListToolbar.tsx:56`, `AlbumView.tsx:89`, `LibraryView.tsx:140`).
  - The Artists header still reads "10 albums · 79 songs" (08). It should be "N artists".

Not resolved:
- **#3** At 900px the bar's left edge is at x=74 and the content gutter at x=88 (31).
- **#10** The empty Favourites hero is unchanged (26): the title is bottom-aligned and the black star is the loudest thing on the page.
- **#4 nit** A 10px strip of shelf art still shows between the floating panel and the stage edge (37, x≈883–890).

## Still between this and 9+, ranked

1. **The album grid reflows partway through a panel open or close** (motion-quarter-speed.mp4, about 3.7–4.0s; my tiles are in council/opus/r3/queue-open.png and queue-close.png).
   - `.lib .album-grid` uses `auto-fill minmax(168px,1fr)` while `.stage`'s `right` animates over 260ms.
   - On close, the cards grow at 5 columns, snap to 6 columns when the width crosses the breakpoint (the cards shrink about 15%), then grow again. On open the change is mirrored.
   - Hiding the sidebar mostly gets this right: the reflow lands near the start.
   - Fix: lay the page out at its destination width for the whole move. When `.is-moving` is set, write the target stage width to `--stage-w-to` and apply `.app.is-moving .stage-main > * { width: var(--stage-w-to); }`, with `.stage-main` clipping as it does now. The grid then reflows once, at the start, under the panel's fade, and the edge just slides.

2. **Opening Now Playing still double-exposes** (np-open.png tiles 3–7, about 100–125ms in real time).
   - Album titles and the grid sit at about 50% under the lyrics at about 40%: text over text, the least legible overlap.
   - The 120ms shell exit helped, but both fades start together. The before capture shows nearly the same overlap.
   - Fix: let the cover-coloured field come up first and the content arrive into it. Use `.npf-art, .npf-lyrics, .npf-corner { transition-delay: 70ms }` on enter only, via `@starting-style` plus the delay on the open state. Alternatively, set `.app.is-immersive` to 90ms and give the lyrics their own 80ms delay. Leave the bar's widening undelayed.

3. **Narrow-width gutter (#3, carried over).** Set `@container stage (max-width: 820px) { --pb-inset: 14px }`, or bring the art's x in line with the page title.

4. **Sources (13): much calmer now; small issues left.**
   - "Details" lands at a different height in each card (y = 428, 455, 450 in the first row). Use `.src-route { display:flex; flex-direction:column } .src-details { margin-top:auto }` so the disclosures line up along the bottom of each row.
   - The quality line for Local is lowercase ("up to 32-bit/192kHz lossless") while the others read "AAC 256kbps". Capitalise it as "Up to".
   - Nit.

5. **Toasts (nit, code).** `AUTO_LEAVE_MS = 6500 - …` repeats the store's timeout. Export one constant from the store, or have the store mark `leaving` itself, so the two can't drift apart.

6. **Leftovers (nit).**
   - `nowplaying-full.css:59` is a comment with no rule after it.
   - `home.css` has an empty line left inside the 820px container query.
   - `.album-info { padding-right: 48px }` now applies at every width. That's fine, but at 1440 it only needs to apply when the corner button overlaps.

## Verdict

The static frames are close to 9. Spacing, materials, states, worst-case data and the menus are all solid now. The two items holding it back are motion seams: the grid reflowing mid-move (#1) and text-on-text double exposure (#2). Both show up every time someone opens the queue or Now Playing. Fixing #1 and #2 would put this at about 9. Clearing #3–4 and the wording would put it at 9+.
