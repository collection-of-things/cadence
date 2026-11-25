BEFORE 5/10 · AFTER 8.8/10

## Round-3 findings

**Resolved**
- **#2 Now Playing double exposure.** At quarter speed (opus/r4/queue-close.png, row 3) the page fades to about 35% with no lyrics present. The room then arrives over an empty field, so text never sits on text. The close is clean too (motion sheet_02, rows 4–5).
- **#3 Narrow gutter.** The bar's art lines up with the page title within about 4px at both 900px and 720px (31, 33).
- **#4 Sources.** The Details links sit on a shared baseline, and "Up to 32-bit…" is capitalised (13).
- **#5 Toasts:** `TOAST_MS` is now shared.
- **#6 Leftovers** are cleaned up.
- **#10 Empty Favourites tile** is calm now (26).
- **#4 nit:** the narrow drawer sits flush and the art strip is gone (37, 38).
- **#7 Wording** is mostly done: the queue reads "8 songs", the filter says "Filter songs", and "Results for "glass"" works well (14).

**Partly resolved**
- **#1 Grid reflow.** The reflow no longer happens mid-move, but it now pops once just after the move ends. See item 1 below.
- **#7 Artists header** still reads "10 albums · 79 songs" (08).

## Still between this and 9.5+, ranked

1. **The album grid pops one beat after the panel settles.** Evidence: opus/r4/queue-open.png, tiles 5→8; motion sheet_01, row 5, cols 4→5; sheet_03, row 1, cols 3→4.
   - While the panel slides, the cards squeeze or stretch smoothly. About 320ms later (`SHELL_MOVE_MS + 60`) the count jumps: 6→5 on open, 5→6 on close, 6→7 when the sidebar hides.
   - On close, the five cards grow to about 230px and then shrink about 17% while Heavy Sun jumps rows. It reads as a second, unrelated motion after everything has stopped, which is the kind of seam a Cider user notices.
   - Fix: animate the column change itself with FLIP in `VirtualAlbumGrid`.
     - Before `setColumns`, record `getBoundingClientRect()` for each mounted card (about 12–20, since the grid is virtualised).
     - In a `useLayoutEffect` keyed on `columns`, animate each card with `el.animate([{transform:\`translate(${dx}px,${dy}px) scale(${sw},${sh})\`, transformOrigin:'0 0'},{transform:'none'}], {duration:240, easing:'cubic-bezier(.2,.8,.2,1)'})`.
     - Under `prefersReducedMotion()`, skip the FLIP, or set the count at the start instead.
   - Cheaper option: put the count change in `document.startViewTransition` with `view-transition-name: album-${id}` on the visible cards. Either way the cards glide into their new grid instead of jumping.

2. **Artists header (wording, carried over).** "10 albums · 79 songs" on the Artists tab should read "10 artists". Change `LibraryView.tsx:~245` to choose the count by `tab`.

3. **Row-menu portal edge cases (code; not visible in the shots).**
   - (a) The menu sits at the end of `<body>`, so Tab from its last item leaves the app instead of returning to the row. Fix: add a `focusout` handler on `menuRef` that closes the menu and refocuses `.row-more` when `relatedTarget` falls outside it, or trap Tab inside the menu as native menus do.
   - (b) The menu closes only on its own scroller's scroll and on window resize. If the stage moves while it is open (a panel or sidebar toggled by shortcut, or Now Playing opening), the fixed menu stays where it is while its row slides away, and it can sit above `.npf` (z 70, outside `.app`). Fix: also close it when `.app.is-moving` or `.is-immersive` is added, or listen for `transitionstart` on `.stage`.
   - Nit-level, but it is the kind of edge case the goal names.

4. **Gutter at the 821–~830px stage width (nit).** In a 900px window the stage is just over 820px wide. The bar keeps its 10px inset there (x=74) while 720 gets 14px (x=78). The art still lines up, so only the bar's outer edge shifts. Use `max-width: 840px`, or tie the bar's container query to the page's own 24px-gutter query.

5. **Sources (nit).** Spotify Web Player puts its Sign in button under Details, so its Details sits about 50px higher than its neighbours' (13, y=449 vs 497). Either put the action before Details, or let the button take the `margin-top:auto` slot and keep Details beneath it on every card.

6. **Lyrics drawer (nit).** In 38 a half line ("Neon on the water", y≈122) is cut off hard by the tab pill. The fade ends below the tabs. Start the top mask at the tab bar's bottom plus 24px so the line dissolves before it reaches the tabs.

7. **Empty Favourites (nit).** The page shows two stars, one on the hero tile and one in the empty-state icon. Drop the `EmptyState` icon here, since the tile already says it.

## Verdict
The static work is at 9+: menus, gutters, wording, worst-case data and materials are all solid. Opening Now Playing now comes together. What stands between this and 9.5 is the grid's late pop (#1), which shows up on every queue, lyrics and sidebar toggle in Albums. With FLIP on that change and the Artists count fixed, I'd score it about 9.4. Items 3–7 take it the rest of the way.
