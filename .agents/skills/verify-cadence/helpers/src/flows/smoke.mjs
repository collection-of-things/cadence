// smoke.mjs — the fast subset wired into verify.sh/CI.
// Launch is already done when a flow runs; smoke proves the app is usable
// end to end on local files only: scan -> browse -> play -> audio on tap ->
// pause. Target: well under a minute.
import { sleep } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, assertAudioRouted, dumpState } from "../lib/flow.mjs";

export const name = "smoke";

export async function run(ctx) {
  const { page, ev } = ctx;

  const snap0 = await api.snapshot(page);
  ev.check("bridge live", typeof snap0.status === "string", `status=${snap0.status}`);
  await shot(ctx, "01-home-empty");

  await seedLibrary(ctx);

  await navTo(ctx, "Library");
  await shot(ctx, "02-library-albums");
  await openAlbumByName(ctx, "Signal Atlas");
  await shot(ctx, "03-album");

  await clickTrack(ctx, "Beacon");
  const snap = await api.waitStatus(page, "playing");
  ev.check("playback started from UI click", true,
    `track=${snap.current?.track?.title} pos=${snap.positionMs}`);
  await assertAudioRouted(ctx);
  await shot(ctx, "04-playing");
  await dumpState(ctx, "playing");

  await page.getByRole("button", { name: "Pause" }).first().click();
  await api.waitStatus(page, "paused");
  ev.check("pause works", true);
  await shot(ctx, "05-paused");
}
