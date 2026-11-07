// smoke.mjs — the fast subset wired into verify.sh/CI.
// Launch is already done when a flow runs; smoke proves the app is usable
// end to end on local files only: scan -> browse -> play -> audio on tap ->
// REAL non-silent monitor capture -> pause. Target: well under a minute.
//
// The audio proof is not just "a link exists": a short monitor capture
// must contain non-silent PCM, so a muted/dead output can't pass on
// graph routing alone.
//
// Deliberate breakage (negative control): `--break mute` mutes the app —
// the run MUST FAIL "capture not silent".
import { sleep } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, assertAudioRouted, dumpState, analyzeCapture, fixtureForTitle } from "../lib/flow.mjs";

export const name = "smoke";

export async function run(ctx) {
  const { page, ev } = ctx;

  const snap0 = await api.snapshot(page);
  ev.check("bridge live", typeof snap0.status === "string", `status=${snap0.status}`);
  await shot(ctx, "01-home-empty");

  await seedLibrary(ctx);

  await navTo(ctx, "Albums", ".lib .album-grid");
  await shot(ctx, "02-library-albums");
  await openAlbumByName(ctx, "Signal Atlas");
  await shot(ctx, "03-album");

  await clickTrack(ctx, "Beacon");
  const snap = await api.waitStatus(page, "playing");
  ev.check("playback started from UI click", snap.current?.track?.title === "Beacon",
    `track=${snap.current?.track?.title} pos=${snap.positionMs} (clicked Beacon)`);
  await assertAudioRouted(ctx);

  if (ctx.breaks?.has("mute")) {
    // NEGATIVE CONTROL: muted output must make the non-silence check FAIL
    await api.send(page, { kind: "setMuted", muted: true });
    ev.step("break", "mute: setMuted(true) — monitor capture must come back silent");
  }

  // short real monitor proof: what the sink receives must be audible PCM
  const ref = fixtureForTitle("Beacon");
  const capPath = ev.audioPath("smoke-monitor.f32le");
  const cap = await ctx.pw.startMonitorCapture(capPath);
  ctx.tracked?.recorders.push(cap);
  try {
    await sleep(3500);
  } finally {
    await cap.stop();
    if (ctx.tracked) ctx.tracked.recorders = ctx.tracked.recorders.filter((r) => r !== cap);
  }
  analyzeCapture(ctx, capPath, {
    ref, minAudibleS: 1.5,
    expectChecks: ["capture input valid", "capture not silent"],
  });
  await shot(ctx, "04-playing");
  await dumpState(ctx, "playing");

  await page.getByRole("button", { name: "Pause" }).first().click();
  await api.waitStatus(page, "paused");
  ev.check("pause works", true);
  await shot(ctx, "05-paused");
}
