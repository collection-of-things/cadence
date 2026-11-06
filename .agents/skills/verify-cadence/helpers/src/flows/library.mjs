// library.mjs — local library indexing and browsing: scan, albums,
// artists, tracks, search filter, album facts.
import { sleep } from "../lib/env.mjs";
import * as api from "../lib/api.mjs";
import { seedLibrary, shot, navTo, openAlbumByName } from "../lib/flow.mjs";

export const name = "library";

export async function run(ctx) {
  const { page, ev } = ctx;
  const tracks = await seedLibrary(ctx);
  ev.check("all 5 fixture tracks indexed", tracks.length === 5, `${tracks.length}`);

  const albumList = await api.albums(page);
  const artistList = await api.artists(page);
  ev.dumpState("library-entities", { albums: albumList, artists: artistList });
  ev.check("two albums indexed", albumList.length === 2,
    albumList.map((a) => a.title).join(", "));
  ev.check("two artists indexed", artistList.length === 2,
    artistList.map((a) => a.name).join(", "));

  // embedded artwork made it through the scanner/thumbnailer
  const withArt = tracks.filter((t) => t.artwork?.url).length;
  ev.check("artwork extracted", withArt >= 5, `${withArt}/5 tracks carry artwork`);

  // user path: library tabs
  await navTo(ctx, "Library");
  await page.locator('.lib-tab:has-text("Artists")').click();
  await shot(ctx, "artists");
  await page.locator('.lib-tab:has-text("Tracks")').click();
  await shot(ctx, "tracks");
  const rows = await page.locator(".tr-row").count();
  ev.check("track rows render", rows >= 5, `${rows} rows`);

  // text filter through the real DB query path
  const filtered = await api.tracks(page, { text: "field" });
  ev.check("library text filter", filtered.length === 2 && filtered.every((t) => t.album === "Field Notes"),
    `${filtered.length} hit(s)`);

  // artist row plays that artist's first track
  await page.locator('.lib-tab:has-text("Artists")').click();
  await page.locator('.artist-row:has-text("Vector Choir")').click();
  const snap = await api.waitStatus(page, "playing");
  ev.check("artist row plays", snap.current?.track?.artists?.[0]?.name === "Vector Choir",
    `${snap.current?.track?.title}`);

  // album view facts (year/genre/track count from tags)
  await navTo(ctx, "Library");
  await openAlbumByName(ctx, "Signal Atlas");
  const facts = await page.locator(".album-fact").allTextContents();
  ev.check("album facts show track count", facts.some((f) => /3 tracks/.test(f)),
    facts.join(" | "));
  await shot(ctx, "album-facts");
}
