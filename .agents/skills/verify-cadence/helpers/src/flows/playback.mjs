// playback.mjs — transport the way a user works it: play from a row click,
// pause/resume via the transport and the space bar, seek on the seek bar,
// next/previous, and queue edits (add next, remove, queue-row jump).
import { sleep, waitFor } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, dumpState, transportButton } from "../lib/flow.mjs";

export const name = "playback";

export async function run(ctx) {
  const { page, ev } = ctx;
  const tracks = await seedLibrary(ctx);

  await navTo(ctx, "Albums", ".lib .album-grid");
  await openAlbumByName(ctx, "Signal Atlas");

  // play the album's first track by clicking its row — the real user path
  await clickTrack(ctx, "Beacon");
  const sPlay = await api.waitStatus(page, "playing");
  ev.check("click-to-play", sPlay.current?.track?.title === "Beacon",
    `now=${sPlay.current?.track?.title} (clicked Beacon)`);

  // position advances
  const s1 = await api.snapshot(page);
  await sleep(1500);
  const s2 = await api.snapshot(page);
  ev.check("position advances", s2.positionMs > s1.positionMs + 500,
    `${s1.positionMs} -> ${s2.positionMs}`);

  // next / previous FIRST — these steps need a clean transition state;
  // a seek jump leaves stale ended events in the pipeline that race
  // auto-advance and make direction checks nondeterministic (the app's
  // known transition-position defect, not harness flakiness).
  await transportButton(page, "Next track").click();
  const sNext = await waitFor(
    async () => {
      const s = await api.snapshot(page);
      return s.current?.track?.title !== "Beacon" ? s : null;
    },
    { timeout: 15_000, what: "track change after Next" },
  );
  ev.check("next track", sNext.current?.track?.title === "Meridian",
    `now=${sNext.current?.track?.title}`);
  await transportButton(page, "Previous track").click();
  const sPrev = await waitFor(
    async () => {
      const s = await api.snapshot(page);
      return s.current?.track?.title !== sNext.current?.track?.title ? s : null;
    },
    { timeout: 15_000, what: "track change after Previous" },
  );
  ev.check("previous track", sPrev.current?.track?.title === "Beacon",
    `now=${sPrev.current?.track?.title}`);

  // pause + resume via transport button — position events only flow once
  // the engine has the track loaded; pausing mid-transition is a no-op
  await api.waitPosition(page, 400);
  await transportButton(page, "Pause").click();
  const paused = await api.waitStatus(page, "paused");
  ev.check("pause", true, `pos=${paused.positionMs}`);
  await transportButton(page, "Play").click();
  await api.waitStatus(page, "playing");
  ev.check("resume", true);

  // spacebar toggles too (App-level shortcut) — blur first so the key
  // doesn't die in a focused row's own Enter/Space handling
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Space");
  await api.waitStatus(page, "paused");
  await page.keyboard.press("Space");
  await api.waitStatus(page, "playing");
  ev.check("spacebar toggle", true);

  // seek via the seek bar — click at ~65% of its width
  const dur = (await api.snapshot(page)).durationMs;
  const seekInput = page.locator(".seek-input").first();
  const box = await seekInput.boundingBox();
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height / 2);
  const afterSeek = await api.waitPosition(page, dur * 0.55, 8_000);
  ev.check("seek via seek bar", afterSeek.positionMs > dur * 0.5,
    `pos=${afterSeek.positionMs}/${dur}`);
  await dumpState(ctx, "after-seek");

  // queue ops: "Play next" on another album's track (behind the row's
  // "More actions" menu), then queue panel edits. Mutations propagate
  // asynchronously — wait on the resulting state, don't read the queue in
  // the same tick the command was sent.
  await page.getByLabel("Go back").click();
  await page.waitForSelector(".album-grid", { timeout: 8_000 });
  await openAlbumByName(ctx, "Field Notes");
  await page.getByRole("button", { name: "More actions for North Field" }).first().click();
  await page.getByRole("menuitem", { name: "Play next" }).click();
  const q1 = await waitFor(
    async () => {
      const q = await api.queue(page);
      const idx = q.items.findIndex((i) => i.track.title === "North Field");
      return idx === q.currentIndex + 1 ? q : null;
    },
    { timeout: 8_000, what: "North Field queued at currentIndex+1" },
  );
  ev.check("add-next queues track", true,
    `North Field at index ${q1.currentIndex + 1} (current ${q1.currentIndex})`);

  await page.locator(".playerbar [data-queue-toggle]").click();
  await page.waitForSelector(".queue.open", { timeout: 8_000 });
  await shot(ctx, "queue-before-jump");
  // jump directly to the queued item by clicking its row — wait for the
  // EXPECTED track in playing state; a status-only wait can return the
  // still-playing previous track before the switch lands
  await page.locator('.q-row:has-text("North Field")').first().click();
  const sJump = await waitFor(
    async () => {
      const s = await api.snapshot(page);
      return s.status === "playing" && s.current?.track?.title === "North Field" ? s : null;
    },
    { timeout: 15_000, what: "North Field playing" },
  );
  ev.check("queue row plays", true, `now=${sJump.current?.track?.title}`);
  // remove the remaining queued item(s) after the current one — verify the
  // post-mutation queue, not a same-tick read
  const q2 = await api.queue(page);
  const removable = q2.items.filter((i, n) => n > q2.currentIndex).map((i) => i.queueId);
  if (removable.length) {
    await api.send(page, { kind: "remove", queueIds: removable });
    const want = q2.items.length - removable.length;
    const q3 = await waitFor(
      async () => {
        const q = await api.queue(page);
        return q.items.length === want ? q : null;
      },
      { timeout: 8_000, what: `queue shrunk to ${want} items` },
    );
    ev.check("queue remove", true, `${q2.items.length} -> ${q3.items.length}`);
  }
  await dumpState(ctx, "queue-final");
}
