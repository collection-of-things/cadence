// navigate.mjs — the shell a user walks: sidebar, search, album, back/
// forward, queue panel, now playing, settings, sources, playlist stub.
// Every click is paired with the destination it must reach — "clicked
// without throwing" is not a navigation check.
import { sleep } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack } from "../lib/flow.mjs";

export const name = "navigate";

export async function run(ctx) {
  const { page, ev } = ctx;
  await seedLibrary(ctx);

  // sidebar sections — each click must land on its view
  for (const [label, marker] of [["Library", ".lib"], ["Sources", ".src"], ["Home", ".home-view"]]) {
    await navTo(ctx, label, marker);
    ev.check(`sidebar navigates to ${label}`, true, `reached ${marker}`);
    await shot(ctx, `nav-${label.toLowerCase()}`);
  }

  // search drives the library view — the VISIBLE rows must show the hit,
  // not just the DB query underneath
  await page.getByLabel("Search Cadence").fill("Meridian");
  await page.keyboard.press("Enter");
  const visibleHit = await page
    .waitForSelector('.lib .tr-row:has-text("Meridian")', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const hits = await api.tracks(page, { text: "Meridian" });
  ev.check("search finds fixture track (visible + query)", visibleHit && hits.some((t) => t.title === "Meridian"),
    `visible row=${visibleHit}, ${hits.length} api hit(s)`);
  await shot(ctx, "search-meridian");
  // clear both fields — sidebar (shared query) and library (local filter)
  await page.getByLabel("Search Cadence").fill("");
  await page.keyboard.press("Enter");
  await page.getByLabel("Search library").fill("");
  await sleep(600);

  // album open + back/forward — make sure the Albums tab is showing
  await navTo(ctx, "Library", ".lib");
  await page.getByRole("button", { name: "Albums" }).first().click().catch(() => {});
  await openAlbumByName(ctx, "Signal Atlas");
  await page.locator(".album-back").click().catch(() => page.getByLabel("Go back").click());
  const backOk = await page.waitForSelector(".album-grid, .lib", { timeout: 8_000 })
    .then(() => true).catch(() => false);
  ev.check("album back navigation", backOk);
  await page.getByLabel("Go forward").click();
  const fwdOk = await page.waitForSelector(".album-track-row", { timeout: 8_000 })
    .then(() => true).catch(() => false);
  ev.check("forward returns to album", fwdOk);
  await shot(ctx, "album-forward");

  // start something so queue + now-playing have content
  await clickTrack(ctx, "Beacon");
  await api.waitStatus(page, "playing");

  // queue panel
  await page.getByRole("button", { name: "Toggle queue" }).first().click();
  await page.waitForSelector(".queue.open", { timeout: 8_000 });
  const q = await api.queue(page);
  ev.check("queue panel shows queue", q.items.length >= 1, `${q.items.length} item(s)`);
  await shot(ctx, "queue-open");
  await page.getByRole("button", { name: "Toggle queue" }).first().click();

  // now playing overlay — the dialog must actually open, not just the button
  await page.getByLabel("Show now playing").first().click();
  const npOk = await page.waitForSelector('.full-now[role="dialog"]', { timeout: 8_000 })
    .then(() => true).catch(() => false);
  ev.check("now playing overlay opens", npOk);
  await shot(ctx, "now-playing");
  await page.keyboard.press("Escape");

  // settings sheet
  await page.getByRole("button", { name: "Settings" }).click();
  const settingsOk = await page.waitForSelector(".sheet[role=dialog]", { timeout: 8_000 })
    .then(() => true).catch(() => false);
  ev.check("settings sheet opens", settingsOk);
  await shot(ctx, "settings");
  await page.getByLabel("Close settings").click();

  // sources page shows honest route states
  await navTo(ctx, "Sources", ".src");
  const caps = await api.capabilities(page);
  ev.dumpState("capabilities", caps);
  ev.check("local route ready", caps.some((c) => c.route === "local" && c.state === "ready"),
    caps.map((c) => `${c.route}:${c.state}`).join(" "));
  await shot(ctx, "sources");

  // playlist surface: no nav entry on this build — the page exists as a stub.
  const playlistNav = await page.locator('.sidebar-nav-row:has-text("Playlist"), .topbar-segment:has-text("Playlist")').count();
  ev.step("note", `playlist nav entries: ${playlistNav} (stub surface on this build)`);
}
