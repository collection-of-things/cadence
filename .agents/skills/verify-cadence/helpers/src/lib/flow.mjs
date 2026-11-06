// flow.mjs — shared flow plumbing: shot, click helpers, library seeding.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fixtureTracks, FIXTURES, waitFor, sleep } from "./env.mjs";
import { TAP_NAME } from "./pipewire.mjs";
import * as api from "./api.mjs";

/** Scan the checked-in fixture library; returns the indexed tracks. */
export async function seedLibrary(ctx) {
  ctx.ev.step("library", `scan ${FIXTURES}`);
  await api.scan(ctx.page, [FIXTURES]);
  const tracks = await api.waitTrackCount(ctx.page, 5, 45_000);
  ctx.ev.dumpState("library-tracks", tracks);
  ctx.ev.check("fixtures indexed", tracks.length >= 5, `${tracks.length} tracks`);
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

/** Click a sidebar/topbar nav row by its label. */
export async function navTo(ctx, label) {
  const btn = ctx.page.locator(
    `.sidebar-nav-row:has-text("${label}"), .topbar-segment:has-text("${label}")`,
  ).first();
  await btn.click();
  ctx.ev.step("nav", label);
  await sleep(350);
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
 * ourselves first (private cores have no session manager to do it). */
export async function assertAudioRouted(ctx) {
  const pw = ctx.pw;
  const stream = await pw.waitForAppStream(ctx.meta.pid, { timeout: 15_000 });
  ctx.ev.step("pw", `stream node ${stream.nodeId} (audio pid ${stream.audioPid})`);
  ctx.ev.dumpState("pw-stream", { node: stream.props, ports: stream.ports });
  const linked = pw.wireToTap(stream.nodeId);
  if (linked) ctx.ev.step("pw", `wired ${linked} link(s) app->${TAP_NAME}`);
  await sleep(300);
  let sinks = pw.appStreamSinks(stream.nodeId);
  let only = sinks.length > 0 && sinks.every((s) => s.name === TAP_NAME);
  if (!only && pw.mode === "session") {
    // session fallback: pull the stream onto the tap via pulse API
    pw.moveAppSinkInput(stream.audioPid);
    await sleep(400);
    sinks = pw.appStreamSinks(stream.nodeId);
    only = sinks.length > 0 && sinks.every((s) => s.name === TAP_NAME);
  }
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
