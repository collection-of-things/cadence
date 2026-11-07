// flow.mjs — shared flow plumbing: shot, click helpers, library seeding,
// audio routing/capture analysis. Assertions here always target the real
// expected artifact (fixture identity, destination view, the sink's own
// monitor) — never "anything moved".
import { basename, join } from "node:path";
import { fixtureTracks, FIXTURES, waitFor, sleep, run as shellRun, readJson, HELPERS } from "./env.mjs";
import { TAP_NAME } from "./pipewire.mjs";
import * as api from "./api.mjs";

/** Scan the checked-in fixture library; returns the indexed tracks.
 * Waits until the exact fixture FILES are indexed — a count-only pass
 * could accept stale leftovers from a previous scan. */
export async function seedLibrary(ctx) {
  ctx.ev.step("library", `scan ${FIXTURES}`);
  await api.scan(ctx.page, [FIXTURES]);
  const expected = fixtureTracks();
  const norm = (p) => p.replaceAll("\\", "/");
  const tracks = await waitFor(
    async () => {
      const t = await api.tracks(ctx.page);
      const paths = new Set(t.map((tr) => norm(tr.source?.path ?? "")));
      return t.length >= expected.length && expected.every((f) => paths.has(norm(f))) ? t : null;
    },
    { timeout: 45_000, every: 400, what: "all 5 fixture identities indexed" },
  );
  ctx.ev.dumpState("library-tracks", tracks);
  const titles = expected.map((f) => basename(f));
  ctx.ev.check("fixtures indexed (all 5 fixture identities)", tracks.length === expected.length,
    `${tracks.length} tracks — expected ${titles.join(", ")}`);
  return tracks;
}

export async function shot(ctx, name) {
  const p = ctx.ev.shotName(name);
  await ctx.page.screenshot({ path: p });
  ctx.ev.step("shot", name, { path: p });
  return p;
}

export async function dumpState(ctx, name) {
  const [snap, q] = await Promise.all([api.snapshot(ctx.page), api.queue(ctx.page)]);
  ctx.ev.dumpState(name, { snapshot: snap, queue: q });
  return { snap, q };
}

/** Click a sidebar/topbar nav row by its label, then prove we ARRIVED —
 * when `expect` is given, that selector must become visible or this throws. */
export async function navTo(ctx, label, expect = null) {
  const btn = ctx.page.locator(
    `.sidebar-nav-row:has-text("${label}"), .topbar-segment:has-text("${label}")`,
  ).first();
  await btn.click();
  ctx.ev.step("nav", label);
  if (expect) {
    await ctx.page.waitForSelector(expect, { timeout: 8_000 });
  } else {
    await sleep(350);
  }
}

/** Play the first track of an album by opening it and clicking a row.
 *  Works from the Home shelf and from Library — Library's album cards
 *  live behind the "Albums" tab, which may not be active after other
 *  flows left the view on Tracks/Artists. */
export async function openAlbumByName(ctx, title) {
  const card = ctx.page.getByRole("button", { name: new RegExp(`Open ${escapeRe(title)}`) });
  if (!(await card.first().isVisible().catch(() => false))) {
    await ctx.page.getByRole("button", { name: "Albums" }).first().click().catch(() => {});
  }
  await card.first().click();
  ctx.ev.step("nav", `open album ${title}`);
  await ctx.page.waitForSelector(".album-track-row", { timeout: 10_000 });
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Click a track row by title (works in .tr-row and .album-track-row). */
export async function clickTrack(ctx, title) {
  const row = ctx.page.locator(
    `.tr-row:has-text("${title}"), .album-track-row:has-text("${title}")`,
  ).first();
  await row.click();
  ctx.ev.step("drive", `click track ${title}`);
}

/** Assert the app's PipeWire stream is wired to our tap sink — wiring it
 * ourselves first (the private core's policy SM links streams to the only
 * endpoint anyway; this makes the wiring explicit and provable). */
export async function assertAudioRouted(ctx) {
  const pw = ctx.pw;
  const stream = await pw.waitForAppStream(ctx.meta.pid, { timeout: 15_000 });
  ctx.ev.step("pw", `stream node ${stream.nodeId} (audio pid ${stream.audioPid})`);
  ctx.ev.dumpState("pw-stream", { node: stream.props, ports: stream.ports });
  const linked = pw.wireToTap(stream.nodeId);
  if (linked) ctx.ev.step("pw", `wired ${linked} link(s) app->${TAP_NAME}`);
  await sleep(300);
  const sinks = pw.appStreamSinks(stream.nodeId);
  const only = sinks.length > 0 && sinks.every((s) => s.name === TAP_NAME);
  ctx.ev.check(
    "app stream delivers to verify tap",
    only,
    `sinks=${sinks.map((s) => s.name).join(",") || "none"}`,
  );
  return stream;
}

/** Reference track path by title match (for audio analysis). */
export function fixtureForTitle(title) {
  return fixtureTracks().find((p) => basename(p).includes(title)) ?? null;
}

/**
 * Run analyze_audio.py on a capture and replay its checks into evidence.
 * The analyzer must itself succeed, produce a parseable JSON schema, and
 * contain the expected check names — a crashed or truncated analysis is a
 * run failure, never a skipped one. Returns the parsed analysis.
 */
export function analyzeCapture(ctx, capPath, {
  ref, minAudibleS, seekPointS = null, seekDeltaS = null, pausePointS = null,
  expectChecks = [],
}) {
  const ev = ctx.ev;
  const analysisPath = ev.audioPath(`analysis-${Date.now()}.json`);
  const r = shellRun("python3", [
    join(HELPERS, "src", "analyze_audio.py"), capPath,
    "--ref", ref, "--rate", "48000", "--channels", "2",
    "--min-audible-s", String(minAudibleS),
    ...(seekPointS != null ? ["--seek-point-s", seekPointS.toFixed(2), "--seek-delta-s", String(seekDeltaS)] : []),
    ...(pausePointS != null ? ["--pause-point-s", pausePointS.toFixed(2)] : []),
    "--out", analysisPath,
  ]);
  ev.step("analysis", r.out || r.err);
  if (r.code !== 0) {
    // analyzer exited nonzero — surface its output then FAIL as a check so
    // the run can't pass on a broken analysis pipeline
    const names = readJson(analysisPath)?.checks?.map((c) => `${c.name}:${c.ok}`).join(", ");
    ev.check("audio analysis completed", false,
      `analyzer exit ${r.code}${names ? ` — checks: ${names}` : ` — ${r.err.slice(0, 200)}`}`);
  }
  ev.check("audio analysis completed", true);
  const analysis = readJson(analysisPath);
  ev.check("audio analysis schema valid",
    analysis && Array.isArray(analysis.checks) && analysis.checks.length > 0
      && analysis.checks.every((c) => typeof c.name === "string" && typeof c.ok === "boolean"),
    analysis ? `${analysis.checks?.length ?? 0} check(s)` : "no/invalid JSON");
  for (const want of expectChecks) {
    ev.check(`audio analysis produced "${want}"`,
      analysis.checks.some((c) => c.name === want),
      `checks present: ${analysis.checks.map((c) => c.name).join(", ")}`);
  }
  for (const c of analysis.checks) ev.check(`audio: ${c.name}`, c.ok, c.detail);
  return analysis;
}
