// audio.mjs — proves real PCM leaves the app and reaches the audio system.
// Records the dedicated tap sink's monitor (ONLY the monitor — never the
// app's own output ports, which would not prove delivery) while the app
// plays/seeks/pauses, then cross-correlates the capture against the
// decoded fixture. The capture clock is anchored to the first recorded
// samples, and the schedule keeps the source position well inside the
// 16s fixture so the track cannot end mid-check.
//
// Order matters: the seek happens during CONTINUOUS playback because
// resume-from-pause currently restarts the queue on main (see the
// "resume preserves track and position" check — logged as evidence, not
// required).
//
// Deliberate breakage (negative control): `--break mute` mutes the app
// before capture — the run MUST FAIL "capture not silent".
import { sleep, run as shellRun } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, assertAudioRouted, fixtureForTitle, analyzeCapture } from "../lib/flow.mjs";

export const name = "audio";

export async function run(ctx) {
  const { page, ev } = ctx;
  await seedLibrary(ctx);
  await navTo(ctx, "Library", ".lib");
  await openAlbumByName(ctx, "Signal Atlas");

  const ref = fixtureForTitle("Vantage"); // 16s — enough runway for play+seek+pause
  ev.check("fixture reference exists", ref !== null, ref ?? "");

  const capPath = ev.audioPath("monitor-capture.f32le");
  const cap = await ctx.pw.startMonitorCapture(capPath);
  ctx.tracked?.recorders.push(cap); // teardown stops the recorder even on crash
  // capture t=0 = first recorded samples, not the link moment
  const t = () => (Date.now() - cap.t0) / 1000;
  let tSeek = null;
  let tPause = null;
  ev.step("capture", `recording ${capPath} (t0 anchored to first bytes)`);

  try {
    // user path: click the row, let it play ~4.5s of real time
    await clickTrack(ctx, "Vantage");
    await api.waitStatus(page, "playing");
    await assertAudioRouted(ctx);

    if (ctx.breaks?.has("mute")) {
      // NEGATIVE CONTROL: the tap must then capture silence → FAIL
      await api.send(page, { kind: "setMuted", muted: true });
      ev.step("break", "mute: setMuted(true) — capture must come back silent");
    }
    await sleep(4500);

    // deliberate seek +4s while still playing — post-seek capture must
    // correlate with the reference ~4s + elapsed-window-time further in.
    // Vantage is 16s: source position here is ~4.5s + 4s = ~8.5s, leaving
    // ~7.5s of headroom so the track can't end inside the checks.
    const pos = (await api.snapshot(page)).positionMs;
    await api.send(page, { kind: "seek", positionMs: pos + 4000 });
    tSeek = t();
    ev.step("seek", `+4000ms at capture t=${tSeek.toFixed(2)}s`);
    await sleep(3000);

    // pause hole: the tap must go quiet while paused
    const prePause = await api.snapshot(page);
    await page.getByRole("button", { name: "Pause" }).first().click();
    await api.waitStatus(page, "paused");
    tPause = t();
    ev.step("pause", `paused at capture t=${tPause.toFixed(2)}s`);
    await sleep(1600);

    // resume probe — documents actual behavior without gating the run.
    // On main, resume restarts the queue (track change + position reset);
    // the check records whatever the app really does.
    await page.getByRole("button", { name: "Play" }).first().click();
    await api.waitStatus(page, "playing");
    await sleep(1200);
    const postResume = await api.snapshot(page);
    const sameTrack = postResume.current?.track?.id === prePause.current?.track?.id;
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
    if (ctx.tracked) ctx.tracked.recorders = ctx.tracked.recorders.filter((r) => r !== cap);
  }
  const wall = t();
  ev.step("capture", `stopped after ${wall.toFixed(2)}s`);

  // humans get a wav too
  shellRun("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", "48000", "-ac", "2",
    "-i", capPath, ev.audioPath("monitor-capture.wav")]);

  analyzeCapture(ctx, capPath, {
    ref,
    minAudibleS: 6.0,
    seekPointS: tSeek,
    seekDeltaS: 4.0,
    pausePointS: tPause,
    expectChecks: [
      "capture input valid",
      "capture not silent",
      "output level sane",
      "pause silences output",
      "segments align to reference",
      "seek moved output",
    ],
  });
  await shot(ctx, "audio-end");
}
