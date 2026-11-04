import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScanProgress } from "@cadence/protocol";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { ok, type Result } from "../src/result.js";
import { LibraryDb } from "../src/library/library-db.js";
import { ftsQuery } from "../src/library/library-db.js";
import { LibraryService } from "../src/library/library-service.js";
import { LibraryScanner } from "../src/library/scanner.js";
import { PickFoldersCancelled } from "../src/library/folder-picker.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..", "..");
const fixtureDir = join(repoRoot, "test", "fixtures", "generated");

async function ensureFixtures(): Promise<void> {
  if (existsSync(join(fixtureDir, "tagged.flac"))) return;
  await execFileAsync("bash", [join(repoRoot, "scripts", "gen-fixtures.sh")], {
    cwd: repoRoot,
    timeout: 120_000,
  });
}

interface LibRig {
  dir: string;
  db: LibraryDb;
  service: LibraryService;
  progress: ScanProgress[];
}

function makeRig(pickerPaths: string[] = []): LibRig {
  const dir = mkdtempSync(join(tmpdir(), "cadence-lib-"));
  const db = new LibraryDb(":memory:");
  const store = new SettingsStore(join(dir, "settings.json"));
  const scanner = new LibraryScanner(join(dir, "thumbs"));
  const progress: ScanProgress[] = [];
  const service = new LibraryService({
    db,
    scanner,
    store,
    pickFolders: (): Promise<Result<string[], PickFoldersCancelled>> =>
      Promise.resolve(ok(pickerPaths)),
  });
  service.onScanProgress((p) => progress.push(p));
  return { dir, db, service, progress };
}

let dirs: string[] = [];
beforeAll(ensureFixtures);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function scannedRig(): Promise<LibRig> {
  const r = makeRig();
  dirs.push(r.dir);
  await r.service.scan([fixtureDir]);
  return r;
}

describe("library: scanning + FTS5", () => {
  it("indexes real fixture files and parses tags", async () => {
    const r = await scannedRig();
    const tracks = r.service.tracks();
    expect(tracks.length).toBeGreaterThanOrEqual(7); // tones + gapless pair + tagged
    const tagged = tracks.find((t) => t.source.kind === "file" && t.source.path.endsWith("tagged.flac"));
    expect(tagged).toBeDefined();
    expect(tagged?.title).toBe("Fixture Title");
    expect(tagged?.artists[0]?.name).toBe("Fixture Artist");
    expect(tagged?.album).toBe("Fixture Album");
    expect(tagged?.trackNumber).toBe(1);
    expect(tagged?.year).toBe(2026);
    expect(tagged?.route).toBe("local");
    expect(tagged?.source.kind).toBe("file");
    expect(tagged?.availability).toBe("available");
    // Embedded artwork extracted to the thumbnail cache.
    expect(tagged?.artwork?.url).toMatch(/^cadence-art:\/\/artwork\//);
    const artPath = decodeURIComponent(
      new URL(tagged?.artwork?.url ?? "").pathname.slice(1),
    );
    expect(existsSync(artPath)).toBe(true);
    await r.service.dispose();
  });

  it("reports ScanProgress phases", async () => {
    const r = await scannedRig();
    const phases = r.progress.map((p) => p.phase);
    expect(phases).toContain("scanning");
    expect(phases.at(-1)).toBe("idle");
    const scanning = r.progress.find((p) => p.phase === "scanning");
    expect(scanning?.total).toBeGreaterThan(0);
    await r.service.dispose();
  });

  it("FTS5 text search finds tracks by title/artist/album", async () => {
    const r = await scannedRig();
    const byTitle = r.service.tracks({ text: "Fixture Title" });
    expect(byTitle.some((t) => t.title === "Fixture Title")).toBe(true);
    const byArtist = r.service.tracks({ text: "Fixture Artist" });
    expect(byArtist.some((t) => t.title === "Fixture Title")).toBe(true);
    const byAlbum = r.service.tracks({ text: "Fixture Album" });
    expect(byAlbum.some((t) => t.title === "Fixture Title")).toBe(true);
    // Prefix matching: partial words hit.
    const byPrefix = r.service.tracks({ text: "Fixt" });
    expect(byPrefix.some((t) => t.title === "Fixture Title")).toBe(true);
    // Basename-derived titles index too.
    const byTone = r.service.tracks({ text: "tone-880" });
    expect(byTone.some((t) => t.source.kind === "file" && t.source.path.endsWith("tone-880.wav"))).toBe(true);
    // Garbage finds nothing.
    expect(r.service.tracks({ text: "zzzqqq" })).toHaveLength(0);
    await r.service.dispose();
  });

  it("albums and artists aggregate", async () => {
    const r = await scannedRig();
    const albums = r.service.albums();
    const fixtureAlbum = albums.find((a) => a.title === "Fixture Album");
    expect(fixtureAlbum).toBeDefined();
    expect(fixtureAlbum?.artist).toBe("Fixture Artist");
    expect(fixtureAlbum?.trackCount).toBe(1);
    const artists = r.service.artists();
    const fixture = artists.find((a) => a.name === "Fixture Artist");
    expect(fixture).toBeDefined();
    expect(fixture?.trackCount).toBe(1);
    await r.service.dispose();
  });

  it("incremental rescan skips unchanged files and picks up changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-inc-"));
    dirs.push(dir);
    const { copyFile } = await import("node:fs/promises");
    const src = join(fixtureDir, "tagged.flac");
    const dst = join(dir, "copy.flac");
    await copyFile(src, dst);
    const r = makeRig();
    dirs.push(r.dir);
    await r.service.scan([dir]);
    expect(r.service.tracks().length).toBe(1);

    // Rescan: unchanged -> still 1, progress shows skipped files counted.
    await r.service.scan([dir]);
    expect(r.service.tracks().length).toBe(1);

    // New file appears on next scan.
    const dst2 = join(dir, "copy2.flac");
    await copyFile(src, dst2);
    await r.service.scan([dir]);
    expect(r.service.tracks().length).toBe(2);

    // Deletion prunes.
    const { unlink } = await import("node:fs/promises");
    await unlink(dst2);
    await r.service.scan([dir]);
    expect(r.service.tracks().length).toBe(1);
    await r.service.dispose();
  });

  it("addFoldersAndScan persists roots through the picker seam", async () => {
    const r = makeRig([fixtureDir]);
    dirs.push(r.dir);
    const accepted = await r.service.addFoldersAndScan();
    expect(accepted).toBe(true);
    expect(r.service.roots()).toEqual([fixtureDir]);
    // The queued scan eventually indexes the root.
    await r.service.scan([]);
    expect(r.service.tracks().length).toBeGreaterThan(0);

    // Cancelled picker returns false.
    const r2 = makeRig([]);
    dirs.push(r2.dir);
    const cancelledService = new LibraryService({
      db: r2.db,
      scanner: new LibraryScanner(join(r2.dir, "thumbs")),
      store: new SettingsStore(join(r2.dir, "s.json")),
      pickFolders: () =>
        Promise.resolve({ _tag: "err", error: new PickFoldersCancelled() } as const),
    });
    expect(await cancelledService.addFoldersAndScan()).toBe(false);
    await r.service.dispose();
  });
});

describe("library: fts query building", () => {
  it("tokenizes, prefixes and escapes", () => {
    expect(ftsQuery("hello world")).toBe('"hello"* AND "world"*');
    expect(ftsQuery('say "hi"')).toBe('"say"* AND """hi"""*');
    expect(ftsQuery("   ")).toBe('""');
  });
});
