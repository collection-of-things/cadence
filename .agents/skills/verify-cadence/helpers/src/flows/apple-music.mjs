// Real Apple Music UI journey. The caller supplies a copied, signed-in test
// profile; the private PipeWire monitor is the only audio output under test.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { sleep, waitFor } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { shot, transportButton } from "../lib/flow.mjs";
import { descendantPids } from "../lib/isolation.mjs";

export const name = "apple-music";

export async function run(ctx) {
  const { page, ev } = ctx;
  let lastCapability;
  const cap = await waitFor(async () => {
    lastCapability = (await api.capabilities(page)).find((c) => c.route === "apple-musickit");
    return lastCapability?.state === "ready" ? lastCapability : null;
  }, { timeout: 90_000, every: 500, what: "signed-in Apple Music route" }).catch(() => null);
  if (!cap) ev.check("Apple Music signed in", false,
    `state=${lastCapability?.state ?? "unavailable"}; ${lastCapability?.stateDetail ?? "check the copied profile and provider connection"}`);
  ev.check("Apple Music signed in", cap.state === "ready");
  await page.getByRole("radio", { name: "Apple Music", exact: true }).click();
  const search = page.getByLabel("Search Apple Music");
  await search.fill("Daft Punk");
  const searchStart = performance.now();
  await search.press("Enter");
  const row = page.locator(".track-row").filter({ has: page.locator(".tr-index") }).first();
  const searchError = page.getByText("Search failed", { exact: true });
  await row.or(searchError).first().waitFor({ state: "visible", timeout: 60_000 });
  if (await searchError.isVisible()) {
    const detail = await searchError.locator("..").innerText();
    ev.check("Apple Music search succeeds", false, detail);
  }
  ev.step("timing", "search submit to first visible song", { milliseconds: Math.round(performance.now() - searchStart) });
  const title = await row.locator(".tr-title-text").innerText();
  ev.check("search displays a song", title.trim().length > 0);
  await shot(ctx, "apple-search");

  const path = ev.audioPath("apple-monitor.f32le");
  const recorder = await ctx.pw.startMonitorCapture(path);
  ctx.tracked?.recorders.push(recorder);
  let clickWall;
  let playingWall;
  let proofWall;
  let pauseWall;
  let pausedWall;
  let resumeWall;
  let resumeEndWall;
  try {
    clickWall = Date.now();
    const start = performance.now();
    await row.locator(".tr-index").click();
    const snap = await api.waitStatus(page, "playing", 90_000);
    playingWall = Date.now();
    ev.step("timing", "song click to playing state", { milliseconds: Math.round(performance.now() - start) });
    ev.check("selected Apple Music song playing", snap.current?.track?.title === title && snap.current?.track?.route === "apple-musickit");
    const stream = await waitFor(() => {
      const nodes = ctx.pw.streamNodesForPids(descendantPids(ctx.meta.pid));
      return nodes.find((node) => ctx.pw.appStreamSinks(node.id).some((sink) => sink.name === "cadence_verify"));
    }, { timeout: 15_000, every: 250, what: "app-owned audio stream linked to private monitor" });
    ev.check("app-owned audio stream reaches private sink", !!stream, `node=${stream.id}`);
    if (ctx.breaks?.has("mute")) await api.send(page, { kind: "setMuted", muted: true });
    proofWall = Date.now() + 1000; // exclude stream startup transients
    await sleep(6000);
    const after = await api.snapshot(page);
    ev.check("Apple Music position advances", after.current?.track?.id === snap.current?.track?.id && after.positionMs > snap.positionMs + 1000);
    pauseWall = Date.now();
    await transportButton(page, "Pause").click();
    const paused = await api.waitStatus(page, "paused", 20_000);
    pausedWall = Date.now();
    ev.check("Apple Music pauses", true);
    await sleep(2200);
    resumeWall = Date.now();
    await transportButton(page, "Play").click();
    const resumed = await api.waitStatus(page, "playing", 30_000);
    ev.check("resume keeps the selected song", resumed.current?.track?.id === paused.current?.track?.id);
    ev.check("resume preserves position", Math.abs(resumed.positionMs - paused.positionMs) < 3000,
      `paused=${paused.positionMs}ms resumed=${resumed.positionMs}ms`);
    await waitFor(async () => {
      const current = await api.snapshot(page);
      return current.current?.track?.id === paused.current?.track?.id && current.positionMs > paused.positionMs + 1000;
    }, { timeout: 20_000, every: 250, what: "resumed Apple Music position advancing" });
    ev.check("resumed Apple Music position advances", true);
    await sleep(1500);
    resumeEndWall = Date.now();
    await transportButton(page, "Pause").click();
    await api.waitStatus(page, "paused", 20_000);
  } finally {
    await recorder.stop();
    if (ctx.tracked) ctx.tracked.recorders = ctx.tracked.recorders.filter((r) => r !== recorder);
  }
  const bytes = readFileSync(path);
  let peak = 0;
  let onset = -1;
  let audibleSamples = 0;
  let pauseEnergy = 0;
  let pauseSamples = 0;
  let resumedAudible = 0;
  // Only audio after the selected song reaches playing counts as proof.
  const firstSample = Math.max(0, Math.floor((clickWall - recorder.t0) / 1000 * 48000) * 2);
  const playingSample = Math.max(firstSample, Math.ceil((Math.max(playingWall, proofWall) - recorder.t0) / 1000 * 48000) * 2);
  const pauseSample = Math.max(playingSample, Math.floor((pauseWall - recorder.t0) / 1000 * 48000) * 2);
  const sampleAt = (ms) => Math.max(0, Math.floor((ms - recorder.t0) / 1000 * 48000) * 2);
  const pauseStart = sampleAt(pausedWall + 500);
  const pauseEnd = sampleAt(resumeWall - 250);
  const resumeStart = sampleAt(resumeWall + 1000);
  const resumeEnd = sampleAt(resumeEndWall);
  for (let i = firstSample * 4; i + 4 <= bytes.length; i += 4) {
    const sample = Math.abs(bytes.readFloatLE(i));
    if (!Number.isFinite(sample)) { ev.check("audio samples finite", false); }
    if (i / 4 >= playingSample && i / 4 < pauseSample) {
      peak = Math.max(peak, sample);
      if (sample > 0.002) audibleSamples++;
    }
    if (i / 4 >= pauseStart && i / 4 < pauseEnd) { pauseEnergy += sample * sample; pauseSamples++; }
    if (i / 4 >= resumeStart && i / 4 < resumeEnd && sample > 0.002) resumedAudible++;
    if (onset < 0 && sample > 0.002) onset = i / 4;
  }
  ev.check("Apple capture has complete frames", bytes.length > 0 && bytes.length % 8 === 0, `bytes=${bytes.length}`);
  ev.check("Apple Music reaches private monitor", audibleSamples >= 96000,
    `bytes=${bytes.length}, peak=${peak.toFixed(5)}, audible samples=${audibleSamples}`);
  const pauseRms = Math.sqrt(pauseEnergy / Math.max(1, pauseSamples));
  ev.check("pause silences private monitor", pauseSamples >= 48000 && pauseRms < 0.002,
    `samples=${pauseSamples}, rms=${pauseRms.toFixed(5)}`);
  ev.check("resume produces audio", resumedAudible >= 48000, `audible samples=${resumedAudible}`);
  if (onset >= 0 && clickWall && recorder.t0) {
    ev.step("timing", "estimated song click to first audible sample", {
      milliseconds: Math.round(recorder.t0 + onset / (48000 * 2) * 1000 - clickWall),
      note: "threshold 0.002; capture clock uses wall time",
    });
  }
  await shot(ctx, "apple-paused");
}
