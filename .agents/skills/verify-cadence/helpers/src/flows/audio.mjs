// audio.mjs — proves real PCM leaves the app and reaches the audio system.
// Records the dedicated tap sink's monitor while the app plays/seeks/
// pauses, then cross-correlates the capture against the decoded fixture.
// This is the same shared-tap method the issue-1 harness (scripts/
// device_null_test.py) established: capture what the sink receives.
//
// Order matters: the seek happens during CONTINUOUS playback because
// resume-from-pause currently restarts the queue on main (see the
// "resume continuity" check — logged as evidence, not required).
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { sleep, run as shellRun } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, assertAudioRouted, fixtureForTitle } from "../lib/flow.mjs";
import { HELPERS } from "../lib/env.mjs";

export const name = "audio";

export async function run(ctx) {
  const { page, ev } = ctx;
  await seedLibrary(ctx);
  await navTo(ctx, "Library");
  await openAlbumByName(ctx, "Signal Atlas");

  const ref = fixtureForTitle("Vantage"); // 16s — enough runway for play+seek
  ev.check("fixture reference exists", ref !== null, ref ?? "");

  const capPath = ev.audioPath("monitor-capture.f32le");
  const cap = await ctx.pw.startMonitorCapture(capPath);
  const t0 = Date.now();
  const t = () => (Date.now() - t0) / 1000;
  let tSeek = null;
  let tPause = null;
  ev.step("capture", `recording ${capPath}`);

  try {
    // user path: click the row, let it play ~5s of real time
    await clickTrack(ctx, "Vantage");
    await api.waitStatus(page, "playing");
    await assertAudioRouted(ctx);
    await sleep(5000);

    // deliberate seek +5s while still playing — post-seek capture must
    // correlate with the reference ~5s further in
    const pos = (await api.snapshot(page)).positionMs;
    await api.send(page, { kind: "seek", positionMs: pos + 5000 });
    tSeek = t();
    ev.step("seek", `+5000ms at capture t=${tSeek.toFixed(2)}s`);
    await sleep(3500);

    // pause hole: the tap must go quiet while paused
    const prePause = await api.snapshot(page);
    await page.getByRole("button", { name: "Pause" }).first().click();
    await api.waitStatus(page, "paused");
    tPause = t();
    ev.step("pause", `paused at capture t=${tPause.toFixed(2)}s`);
    await sleep(1800);

    // resume probe — documents actual behavior without gating the run.
    // On main, resume restarts the queue (track change + position reset);
    // the check records whatever the app really does.
    await page.getByRole("button", { name: "Play" }).first().click();
    await api.waitStatus(page, "playing");
    await sleep(1200);
    const postResume = await api.snapshot(page);
    const sameTrack = postResume.current?.track?.title === prePause.current?.track?.title;
    const posKept = Math.abs(postResume.positionMs - prePause.positionMs) < 2500;
    ev.check(
      "resume preserves track and position",
      sameTrack && posKept,
      `${prePause.current?.track?.title}@${prePause.positionMs}ms -> ${postResume.current?.track?.title}@${postResume.positionMs}ms`,
      { required: false },
    );

    await page.getByRole("button", { name: "Pause" }).first().click();
    await api.waitStatus(page, "paused");
  } finally {
    await cap.stop();
  }
  const wall = t();
  ev.step("capture", `stopped after ${wall.toFixed(2)}s`);

  // humans get a wav too
  shellRun("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", "48000", "-ac", "2",
    "-i", capPath, ev.audioPath("monitor-capture.wav")]);

  const analysisPath = ev.audioPath("analysis.json");
  const r = shellRun("python3", [
    join(HELPERS, "src", "analyze_audio.py"), capPath,
    "--ref", ref, "--rate", "48000", "--channels", "2",
    "--min-audible-s", "7.0",
    ...(tSeek != null ? ["--seek-point-s", tSeek.toFixed(2), "--seek-delta-s", "5.0"] : []),
    ...(tPause != null ? ["--pause-point-s", tPause.toFixed(2)] : []),
    "--out", analysisPath,
  ]);
  ev.step("analysis", r.out || r.err);
  const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
  for (const c of analysis.checks) ev.check(`audio: ${c.name}`, c.ok, c.detail);
  await shot(ctx, "audio-end");
}
