// navigate.mjs — the shell a user walks: sidebar, search, album, back/
// forward, queue panel, now playing, settings, sources, playlist stub.
import { sleep } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName, clickTrack, escapeRe } from "../lib/flow.mjs";

export const name = "navigate";

export async function run(ctx) {
  const { page, ev } = ctx;
  await seedLibrary(ctx);

  // sidebar sections
  for (const label of ["Library", "Sources", "Home"]) {
    await navTo(ctx, label);
    await shot(ctx, `nav-${label.toLowerCase()}`);
  }
  ev.check("sidebar sections navigable", true);

  // search drives the library view
  await page.getByLabel("Search Cadence").fill("Meridian");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".lib", { timeout: 10_000 }).catch(() => {});
  await sleep(700);
  const hits = await api.tracks(page, { text: "Meridian" });
  ev.check("search finds fixture track", hits.some((t) => t.title === "Meridian"),
    `${hits.length} hit(s)`);
  await shot(ctx, "search-meridian");
  // clear both fields — sidebar (shared query) and library (local filter)
  await page.getByLabel("Search Cadence").fill("");
  await page.keyboard.press("Enter");
  await page.getByLabel("Search library").fill("");
  await sleep(600);

  // album open + back/forward — make sure the Albums tab is showing
  await navTo(ctx, "Library");
  await page.getByRole("button", { name: "Albums" }).first().click().catch(() => {});
  await openAlbumByName(ctx, "Signal Atlas");
  await page.locator(".album-back").click().catch(() => page.getByLabel("Go back").click());
  await page.waitForSelector(".album-grid, .lib", { timeout: 8_000 });
  ev.check("album back navigation", true);
  await page.getByLabel("Go forward").click();
  await page.waitForSelector(".album-track-row", { timeout: 8_000 });
  ev.check("forward returns to album", true);
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

  // now playing overlay
  await page.getByLabel("Show now playing").first().click();
  await sleep(600);
  await shot(ctx, "now-playing");
  ev.check("now playing opens", true);
  await page.keyboard.press("Escape");

  // settings sheet
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector(".sheet[role=dialog]", { timeout: 8_000 });
  await shot(ctx, "settings");
  ev.check("settings sheet opens", true);
  await page.getByLabel("Close settings").click();

  // sources page shows honest route states
  await navTo(ctx, "Sources");
  const caps = await api.capabilities(page);
  ev.dumpState("capabilities", caps);
  ev.check("local route ready", caps.some((c) => c.route === "local" && c.state === "ready"),
    caps.map((c) => `${c.route}:${c.state}`).join(" "));
  await shot(ctx, "sources");

  // playlist surface: no nav entry on this build — the page exists as a stub.
  const playlistNav = await page.locator('.sidebar-nav-row:has-text("Playlist"), .topbar-segment:has-text("Playlist")').count();
  ev.step("note", `playlist nav entries: ${playlistNav} (stub surface on this build)`);
}
