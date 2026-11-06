// restart.mjs — quit mid-track, relaunch, prove the session came back:
// queue intact, same track, position near where we left, status PAUSED
// (never autoplay after restart — that's a product requirement, and a
// regression here is exactly what this flow exists to catch).
//
// Evidence-first structure: every observation is recorded BEFORE the
// contract gate, so a restore defect fails the run with the full picture
// in the transcript — never silently short-circuiting past evidence.
import { join } from "node:path";
import { sleep } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, dumpState } from "../lib/flow.mjs";
import { quitManaged, relaunchManaged } from "../lib/session.mjs";

export const name = "restart";

export async function run(ctx) {
  const { page, ev } = ctx;
  await seedLibrary(ctx);
  await navTo(ctx, "Library");
  await openAlbumByName(ctx, "Signal Atlas");
  await clickTrack(ctx, "Beacon");
  await api.waitStatus(page, "playing");
  await sleep(4000); // let position get well past the persist debounce

  const before = await api.snapshot(page);
  const qBefore = await api.queue(page);
  ev.check("playing before quit", before.status === "playing",
    `${before.current?.track?.title} @ ${before.positionMs}ms`);
  await shot(ctx, "before-quit");

  // graceful quit — will-quit -> coordinator.persistNow(). quitManaged
  // reports whether the app exited on its own or needed the SIGKILL
  // fallback; a killed quit can let the track end during the window and
  // contaminate persisted state, so the transcript must record it.
  const quitMode = await quitManaged(ctx.app);
  ev.step("quit", `mode=${quitMode}`);

  // the persisted file is evidence in its own right
  const settingsPath = join(ctx.ud, "cadence-settings.json");
  ev.copyIn(settingsPath, "cadence-settings-after-quit.json");

  await relaunchManaged(ctx);
  const page2 = ctx.page;
  await shot(ctx, "after-relaunch");

  const restored = await api.snapshot(page2);
  const qAfter = await api.queue(page2);
  await dumpState(ctx, "restored");

  // paused = nothing in the audio graph yet: no stream node may exist
  await sleep(1500);
  const stray = ctx.pw.streamNodesForPids(ctx.pw.descendantPids(ctx.meta.pid));

  // record every observation first — the contract gate reads them all
  const obs = {
    "queue restored": [
      qAfter.items.length === qBefore.items.length,
      `${qBefore.items.length} -> ${qAfter.items.length}`,
    ],
    "same track restored": [
      restored.current?.track?.title === before.current?.track?.title,
      `${before.current?.track?.title} -> ${restored.current?.track?.title}`,
    ],
    "comes back PAUSED (no autoplay)": [
      restored.status === "paused",
      `status=${restored.status}`,
    ],
    "position restored near quit point": [
      Math.abs(restored.positionMs - before.positionMs) < 4000,
      `quit@${before.positionMs}ms restored@${restored.positionMs}ms`,
    ],
    "no audio stream while paused": [
      stray.length === 0,
      `${stray.length} stream node(s)`,
    ],
  };
  for (const [n, [ok, d]] of Object.entries(obs)) {
    ev.check(n, ok, d, { required: false });
  }

  // resume from the restored position like a returning user would —
  // try the transport button first (what a user hits), fall back to the
  // bridge command so a UI-path hiccup doesn't hide a working restore.
  let resumed = null;
  let transportWorked = false;
  await page2.getByRole("button", { name: "Play" }).first().click().catch(() => {});
  try {
    resumed = await api.waitStatus(page2, "playing", 6000);
    transportWorked = true;
    ev.step("resume", "transport Play resumed the restored session");
  } catch {
    const rr = await api.send(page2, { kind: "resume" });
    try {
      resumed = await api.waitStatus(page2, "playing", 10000);
      ev.step("resume", `transport click inert; bridge resume -> ${rr === undefined ? "ok" : rr}`);
    } catch {
      ev.check("resume after restore", false,
        "neither transport Play nor bridge resume started playback", { required: false });
    }
  }
  if (resumed !== null) {
    ev.check("transport Play resumes after restore", transportWorked,
      transportWorked ? "UI button works" : "UI Play inert; bridge fallback resumed (UI defect)",
      { required: false });
    obs["resume after restore"] = [
      resumed.status === "playing" && (resumed.positionMs ?? 0) >= 0,
      `resumed ${resumed.current?.track?.title} @ ${resumed.positionMs}ms`,
    ];
    ev.check("resume after restore", obs["resume after restore"][0],
      obs["resume after restore"][1], { required: false });
  }
  await shot(ctx, "resumed");

  // the contract, all observations in one required gate
  const failed = Object.entries(obs).filter(([, [ok]]) => !ok).map(([n]) => n);
  ev.check(
    "restart restores queue + track + position, comes back paused",
    failed.length === 0,
    failed.length ? `failed: ${failed.join(", ")}` : "all restore invariants hold",
  );
}
