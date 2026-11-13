// navigate.mjs — the shell a user walks: sidebar rows, search, album, back/
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

  // sidebar rows — each click must land on its view. The library tabs are
  // sidebar rows since the redesign: Songs/Albums/Artists each render a
  // distinct body inside the same .lib view.
  for (const [label, marker] of [
    ["Home", ".home"],
    ["Sources", ".src"],
    ["Songs", ".lib .tr-scroll"],
    ["Albums", ".lib .album-grid"],
    ["Artists", ".lib .artist-list"],
  ]) {
    await navTo(ctx, label, marker);
    ev.check(`sidebar navigates to ${label}`, true, `reached ${marker}`);
    await shot(ctx, `nav-${label.toLowerCase()}`);
  }

  // search drives the library view — the VISIBLE rows must show the hit,
  // not just the DB query underneath
  await page.getByLabel("Search your music").fill("Meridian");
  await page.keyboard.press("Enter");
  const visibleHit = await page
    .waitForSelector('.lib .track-row:has-text("Meridian")', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const hits = await api.tracks(page, { text: "Meridian" });
  ev.check("search finds fixture track (visible + query)", visibleHit && hits.some((t) => t.title === "Meridian"),
    `visible row=${visibleHit}, ${hits.length} api hit(s)`);
  await shot(ctx, "search-meridian");
  // the sidebar field clears itself on Enter; clear the library filter it set
  await page.getByLabel("Search library").fill("");
  await sleep(600);

  // album open + back/forward — land on the Albums grid first
  await navTo(ctx, "Albums", ".lib .album-grid");
  await openAlbumByName(ctx, "Signal Atlas");
  await page.getByLabel("Go back").click();
  const backOk = await page.waitForSelector(".album-grid", { timeout: 8_000 })
    .then(() => true).catch(() => false);
  ev.check("album back navigation", backOk);
  await page.getByLabel("Go forward").click();
  const fwdOk = await page.waitForSelector(".album .track-row", { timeout: 8_000 })
    .then(() => true).catch(() => false);
  ev.check("forward returns to album", fwdOk);
  await shot(ctx, "album-forward");

  // start something so queue + now-playing have content
  await clickTrack(ctx, "Beacon");
  await api.waitStatus(page, "playing");

  // queue panel — scope to the player bar's toggle: pinned albums and the
  // top bar/now-playing dock share the data-queue-toggle hook and a "Queue*"
  // album title could otherwise win the accessible-name match
  await page.locator(".playerbar [data-queue-toggle]").click();
  await page.waitForSelector(".queue.open", { timeout: 8_000 });
  const q = await api.queue(page);
  ev.check("queue panel shows queue", q.items.length >= 1, `${q.items.length} item(s)`);
  await shot(ctx, "queue-open");
  await page.locator(".playerbar [data-queue-toggle]").click();

  // now playing overlay — the dialog must actually open, not just the button
  await page.getByRole("button", { name: "Open now playing" }).first().click();
  const npOk = await page.waitForSelector('.npf[role="dialog"]', { timeout: 8_000 })
    .then(() => true).catch(() => false);
  ev.check("now playing overlay opens", npOk);
  await shot(ctx, "now-playing");
  await page.keyboard.press("Escape");

  // settings page: the gear opens it and leads back out
  await page.getByRole("button", { name: "Settings" }).click();
  const settingsOk = await page.waitForSelector(".set-page", { timeout: 8_000 })
    .then(() => true).catch(() => false);
  ev.check("settings page opens", settingsOk);
  await shot(ctx, "settings");
  await page.getByRole("button", { name: "Settings" }).click();

  // sources page shows honest route states
  await navTo(ctx, "Sources", ".src");
  const caps = await api.capabilities(page);
  ev.dumpState("capabilities", caps);
  ev.check("local route ready", caps.some((c) => c.route === "local" && c.state === "ready"),
    caps.map((c) => `${c.route}:${c.state}`).join(" "));
  await shot(ctx, "sources");

  // playlist surface: no playlist nav row on this build — the sidebar's
  // "Playlists" section only carries Favourite Songs.
  const playlistRows = await page.locator('.sidebar .side-row[aria-label*="Playlist"]').count();
  const playlistHeads = await page.locator('.sidebar .side-section-head:has-text("Playlists")').count();
  ev.step("note", `playlist nav rows: ${playlistRows}, playlists sections: ${playlistHeads} (stub surface on this build)`);
}
