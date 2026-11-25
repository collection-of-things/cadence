BEFORE 5/10 · AFTER 9.4/10

## Round-4 findings: all resolved
1. **Grid pop**: resolved. At quarter speed (opus/r5/open30.png, close30.png; motion sheets 01 rows 3–5 and 03 row 1), Heavy Sun and Ember Rites now glide to their new slots instead of jumping. The column change starts on the frame `.is-moving` drops, not on a timer, and the reduced-motion path skips it.
2. **Artists header**: resolved. It reads "10 artists" (opus/r5/c08.png).
3. **Row-menu portal**: resolved in code. Arrow keys, Home and End move through the items. Tab hands focus back to `.row-more` without `preventDefault`, so focus continues in list order. A MutationObserver on `.app` closes the menu on `is-moving` or `is-immersive`.
4. **840px inset**: resolved.
5. **Sources Details**: resolved. All three top cards put Details on one line (c13.png).
6. **Lyrics top fade**: resolved. Lines dissolve below the tabs (c38.png).
7. **Double star**: resolved. Only one star remains (c26.png).

## Regressions
None found. The audits are empty and the static shots match r4 or look better. The new side-panel fades work as intended: the panel fades out before the stage reaches it, and when docked it fades in after the stage moves.

## Blockers
None.

## Nits
- **FLIP z-order.** Every `.album-row` has a transform, so each row is its own stacking context. A card moving between rows can pass under its neighbours.
  - On queue open, Heavy Sun slides under Ember Rites (open30, row 4). On close, it slides under row 2 (close30, row 3).
  - This lasts about 2–3 real frames.
  - Fix: during the animation, set `zIndex: 1` on each card with `|dy| > 1` and on its parent row, then clear both in `animation.finished`.
- **Artist count.** The count calls `api.library.artists({})` and loads the whole list just to read `.length`. Add `artists` to `library.counts()` so large libraries don't pay for it.
- **Virtualizer row sizes (unverified).** Rows are measured by a ResizeObserver, so the FLIP's target positions could come from the old row heights. I saw no vertical jump at this library size. Calling `virtualizer.measure()` before `setColumns` would rule it out.
