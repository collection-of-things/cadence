// playback.mjs — transport the way a user works it: play from a row click,
// pause/resume via the transport and the space bar, seek on the seek bar,
// next/previous, and queue edits (add next, remove, queue-row jump).
import { sleep, waitFor } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, dumpState } from "../lib/flow.mjs";

export const name = "playback";

export async function run(ctx) {
  const { page, ev } = ctx;
  const tracks = await seedLibrary(ctx);

  await navTo(ctx, "Library");
  await openAlbumByName(ctx, "Signal Atlas");

  // play the album's first track by clicking its row — the real user path
  await clickTrack(ctx, "Beacon");
  await api.waitStatus(page, "playing");
  ev.check("click-to-play", true);

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
  await page.getByRole("button", { name: "Next track" }).first().click();
  const sNext = await waitFor(
    async () => {
      const s = await api.snapshot(page);
      return s.current?.track?.title !== "Beacon" ? s : null;
    },
    { timeout: 15_000, what: "track change after Next" },
  );
  ev.check("next track", sNext.current?.track?.title === "Meridian",
    `now=${sNext.current?.track?.title}`);
  await page.getByRole("button", { name: "Previous track" }).first().click();
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
  await page.getByRole("button", { name: "Pause" }).first().click();
  const paused = await api.waitStatus(page, "paused");
  ev.check("pause", true, `pos=${paused.positionMs}`);
  await page.getByRole("button", { name: "Play" }).first().click();
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

  // queue ops: "Add next" on another album's track, then queue panel edits
  await page.getByLabel("Go back").click();
  await page.waitForSelector(".album-grid", { timeout: 8_000 });
  await openAlbumByName(ctx, "Field Notes");
  await page.getByRole("button", { name: "Add North Field next" }).first().click();
  const q1 = await api.queue(page);
  const idx = q1.items.findIndex((i) => i.track.title === "North Field");
  ev.check("add-next queues track", idx === q1.currentIndex + 1,
    `North Field at index ${idx} (current ${q1.currentIndex})`);

  await page.getByRole("button", { name: "Toggle queue" }).first().click();
  await page.waitForSelector(".queue.open", { timeout: 8_000 });
  await shot(ctx, "queue-before-jump");
  // jump directly to the queued item by clicking its row
  await page.locator('.q-row:has-text("North Field")').first().click();
  const sJump = await api.waitStatus(page, "playing", 15_000);
  ev.check("queue row plays", sJump.current?.track?.title === "North Field",
    `now=${sJump.current?.track?.title}`);
  // remove the remaining queued item(s) after the current one
  const q2 = await api.queue(page);
  const removable = q2.items.filter((i, n) => n > q2.currentIndex).map((i) => i.queueId);
  if (removable.length) {
    await api.send(page, { kind: "remove", queueIds: removable });
    const q3 = await api.queue(page);
    ev.check("queue remove", q3.items.length === q2.items.length - removable.length,
      `${q2.items.length} -> ${q3.items.length}`);
  }
  await dumpState(ctx, "queue-final");
}
