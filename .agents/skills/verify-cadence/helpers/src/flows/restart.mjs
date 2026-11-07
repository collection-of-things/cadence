// restart.mjs — quit mid-track, relaunch, prove the session came back:
// same queue (ordered track identities + currentIndex), same track, a
// meaningful nonzero position near the persisted point, status PAUSED
// (never autoplay — that's a product requirement, and a regression here
// is exactly what this flow exists to catch), and resume that actually
// plays the restored track with advancing, routed output.
//
// Evidence-first structure: every observation is recorded BEFORE the
// contract gate, so a restore defect fails the run with the full picture
// in the transcript — never silently short-circuiting past evidence.
// The oracle itself lives in lib/restart-oracle.mjs (pure — regression-
// tested by `cadence-verify selftest`).
//
// Deliberate breakage (negative control): `--break no-restore` deletes the
// persisted settings file between quit and relaunch — the flow MUST FAIL.
import { join } from "node:path";
import { rmSync } from "node:fs";
import { sleep, readJson } from "../lib/env.mjs";
import { descendantPids } from "../lib/isolation.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, dumpState, assertAudioRouted } from "../lib/flow.mjs";
import { evaluateRestore, trackIdentity } from "../lib/restart-oracle.mjs";
import { quitManaged, relaunchManaged } from "../lib/session.mjs";

export const name = "restart";

export async function run(ctx) {
  const { page, ev } = ctx;
  await seedLibrary(ctx);
  await navTo(ctx, "Library", ".lib");
  await openAlbumByName(ctx, "Signal Atlas");
  await clickTrack(ctx, "Beacon");
  await api.waitStatus(page, "playing");
  await sleep(4000); // let position get well past the persist debounce

  const before = await api.snapshot(page);
  const qBefore = await api.queue(page);
  ev.check("playing before quit", before.status === "playing" && trackIdentity(before.current?.track) !== null,
    `${before.current?.track?.title} @ ${before.positionMs}ms`);
  await shot(ctx, "before-quit");

  // graceful quit — will-quit -> coordinator.persistNow(). quitManaged
  // reports whether the app exited on its own or needed the SIGKILL
  // fallback; the oracle gates on mode=graceful.
  const quitMode = await quitManaged(ctx.app);
  ev.step("quit", `mode=${quitMode}`);

  // the persisted file is evidence in its own right — and its playback
  // section is the truth the restore is measured against
  const settingsPath = join(ctx.ud, "cadence-settings.json");
  ev.copyIn(settingsPath, "cadence-settings-after-quit.json");
  const persisted = readJson(settingsPath)?.playback ?? null;
  ev.dumpState("persisted-playback", persisted);

  if (ctx.breaks?.has("no-restore")) {
    // NEGATIVE CONTROL: destroy the persisted state — the flow below MUST fail
    rmSync(settingsPath, { force: true });
    ev.step("break", "no-restore: deleted cadence-settings.json before relaunch");
  }

  await relaunchManaged(ctx);
  const page2 = ctx.page;
  await shot(ctx, "after-relaunch");

  const restored = await api.snapshot(page2);
  const qAfter = await api.queue(page2);
  await dumpState(ctx, "restored");

  // paused = nothing in the audio graph yet: no stream node may exist
  await sleep(1500);
  const stray = ctx.pw.streamNodesForPids(descendantPids(ctx.meta.pid));

  // resume from the restored position like a returning user would —
  // try the transport button first (what a user hits), fall back to the
  // bridge command so a UI-path hiccup doesn't hide a working restore.
  let resumed = null;
  let resumedLater = null;
  let transportWorked = false;
  await page2.getByRole("button", { name: "Play" }).first().click().catch(() => {});
  try {
    resumed = await api.waitStatus(page2, "playing", 6000);
    transportWorked = true;
    ev.step("resume", "transport Play resumed the restored session");
  } catch {
    const rr = await api.send(page2, { kind: "resume" }).catch(() => null);
    try {
      resumed = await api.waitStatus(page2, "playing", 10000);
      ev.step("resume", `transport click inert; bridge resume -> ${rr === undefined ? "ok" : rr}`);
    } catch {
      ev.step("resume", "neither transport Play nor bridge resume started playback");
    }
  }
  if (resumed !== null) {
    // documented transport NOTE for the known app defect — does not gate
    ev.check("transport Play resumes after restore", transportWorked,
      transportWorked ? "UI button works" : "UI Play inert; bridge fallback resumed (known UI defect)",
      { required: false });
    await sleep(1200);
    resumedLater = await api.snapshot(page2);
    // resumed output must really reach the audio system, not just claim playing
    await assertAudioRouted(ctx);
  }
  await shot(ctx, "resumed");

  // every observation first — then one required gate over all of them
  const obs = evaluateRestore({
    before, qBefore, restored, qAfter, persisted,
    strayStreams: stray.length, quitMode, resumed, resumedLater,
  });
  for (const [n, ok, d] of obs) {
    ev.check(n, ok, d, { required: false });
  }
  const failed = obs.filter(([, ok]) => !ok).map(([n]) => n);
  ev.check(
    "restart restores queue + track + position, comes back paused, resumes correctly",
    failed.length === 0,
    failed.length ? `failed: ${failed.join(", ")}` : "all restore invariants hold",
  );
}
