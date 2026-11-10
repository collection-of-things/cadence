import { extname, sep } from "node:path";
import { stat } from "node:fs/promises";
import type {
  LibraryAlbum,
  LibraryCounts,
  LibraryQuery,
  ScanProgress,
  TrackRef,
} from "@cadence/protocol";
import { watch, type FSWatcher } from "chokidar";
import { isOk } from "../result.js";
import type { SettingsStore } from "../coordinator/settings-store.js";
import type { FolderPicker } from "./folder-picker.js";
import type { LibraryDb } from "./library-db.js";
import { AUDIO_EXTENSIONS, readLyricsFile, sidecarLyricsPath, type LibraryScanner } from "./scanner.js";

/** Handle for a running filesystem watcher. */
export interface WatcherHandle {
  /** Stop watching; resolves when closed. */
  close(): Promise<void> | void;
}

/** Factory for a watcher over the library roots (chokidar in production). */
export type CreateWatcher = (
  roots: string[],
  onFsChange: (e: { kind: "upsert" | "remove"; path: string }) => void,
) => WatcherHandle;

/** Constructor dependencies for LibraryService. */
export interface LibraryServiceDeps {
  readonly db: LibraryDb;
  readonly scanner: LibraryScanner;
  readonly store: SettingsStore;
  readonly pickFolders: FolderPicker;
  /** Native "choose a lyrics file" dialog; resolves null when cancelled. */
  readonly pickLyricsFile?: () => Promise<string | null>;
  readonly createWatcher?: CreateWatcher;
  /** Files per batch before yielding to the event loop (never block the UI). */
  readonly batchSize?: number;
}

/**
 * Orchestrates the local library: persisted roots, incremental scans driven
 * by mtime, a chokidar watcher, and ScanProgress fan-out. All heavy work is
 * chunked so indexing never blocks the UI.
 */
export class LibraryService {
  private readonly db: LibraryDb;
  private readonly scanner: LibraryScanner;
  private readonly store: SettingsStore;
  private readonly pickFolders: FolderPicker;
  private readonly pickLyricsFile: (() => Promise<string | null>) | undefined;
  private readonly createWatcher: CreateWatcher | undefined;
  private readonly batchSize: number;
  private readonly progressListeners = new Set<(p: ScanProgress) => void>();
  private watcher: WatcherHandle | null = null;
  private scanChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(deps: LibraryServiceDeps) {
    this.db = deps.db;
    this.scanner = deps.scanner;
    this.store = deps.store;
    this.pickFolders = deps.pickFolders;
    this.pickLyricsFile = deps.pickLyricsFile;
    this.createWatcher = deps.createWatcher;
    this.batchSize = deps.batchSize ?? 25;
  }

  /** Persisted library roots. */
  roots(): string[] {
    const section = this.store.loadSection("library");
    if (typeof section === "object" && section !== null) {
      const roots = (section as Record<string, unknown>).roots;
      if (Array.isArray(roots)) return roots.filter((r): r is string => typeof r === "string");
    }
    return [];
  }

  /** Subscribe to scan progress. Returns an unsubscribe function. */
  onScanProgress(cb: (p: ScanProgress) => void): () => void {
    this.progressListeners.add(cb);
    return () => {
      this.progressListeners.delete(cb);
    };
  }

  /**
   * Pick folders via the native dialog seam, add them as roots, and start a
   * scan. Returns false when the user cancelled.
   */
  async addFoldersAndScan(): Promise<boolean> {
    const picked = await this.pickFolders();
    if (!isOk(picked)) return false;
    if (picked.value.length === 0) return true;
    this.addRoots(picked.value);
    void this.scan(picked.value);
    return true;
  }

  /** Drop roots, persist, prune their tracks, and (re)start watching. */
  removeRoots(paths: string[]): void {
    const dropping = new Set(paths);
    this.store.saveSection("library", { roots: this.roots().filter((r) => !dropping.has(r)) });
    for (const p of this.db.allPaths()) {
      if (paths.some((root) => p.startsWith(withSep(root)))) {
        this.db.deleteByPath(p);
      }
    }
    this.startWatcher();
  }

  /** Merge new roots, persist, and (re)start watching. */
  addRoots(paths: string[]): void {
    const merged = [...new Set([...this.roots(), ...paths])];
    this.store.saveSection("library", { roots: merged });
    this.startWatcher();
  }

  /**
   * Scan the given paths (defaults to all roots). Incremental: files whose
   * mtime+size match the index are skipped; missing files are pruned when
   * their containing root is rescanned. Chained — concurrent calls do not
   * overlap.
   */
  async scan(paths?: string[]): Promise<void> {
    const targets = paths ?? this.roots();
    const p = this.scanChain.then(() => this.runScan(targets));
    // The caller sees the failure; the chain recovers so later scans still run.
    this.scanChain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /** Track search/list (FTS5 text + field filters). */
  tracks(q: LibraryQuery = {}): TrackRef[] {
    return this.db.tracks(q);
  }

  /** Album list. */
  albums(q: LibraryQuery = {}): LibraryAlbum[] {
    return this.db.albums(q);
  }

  /** Artist list with counts. */
  artists(q: LibraryQuery = {}): { name: string; albumCount: number; trackCount: number }[] {
    return this.db.artists(q);
  }

  /** Album and track totals for the whole library. */
  counts(): LibraryCounts {
    return this.db.counts();
  }

  /** One track by id, or null. */
  track(id: string): TrackRef | null {
    return this.db.track(id);
  }

  /**
   * Let the listener pick a lyrics file for a track and attach it. Resolves
   * to the updated track, or null when the dialog was cancelled. Rejects when
   * the file holds no readable lyrics.
   */
  async importLyrics(trackId: string): Promise<TrackRef | null> {
    if (this.pickLyricsFile === undefined || this.db.track(trackId) === null) return null;
    const file = await this.pickLyricsFile();
    if (file === null) return null;
    const text = await readLyricsFile(file);
    if (text === null) throw new Error("That file has no lyrics in it");
    this.db.setLyricsOverride(trackId, text);
    return this.db.track(trackId);
  }

  /** Store a track's lyric sync nudge and return the updated track. */
  setLyricsOffset(trackId: string, offsetMs: number): TrackRef | null {
    this.db.setLyricsOffset(trackId, offsetMs);
    return this.db.track(trackId);
  }

  /** Start (or restart) the filesystem watcher over current roots. */
  startWatcher(): void {
    if (this.createWatcher === undefined || this.disposed) return;
    this.watcher?.close();
    const roots = this.roots();
    if (roots.length === 0) {
      this.watcher = null;
      return;
    }
    this.watcher = this.createWatcher(roots, (e) => this.onFsChange(e));
    this.emitProgress({ phase: "watching", scanned: 0 });
  }

  /** Stop watching and flush; the DB stays open for queries. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.watcher?.close();
    this.watcher = null;
    await this.scanChain.catch(() => undefined);
  }

  // --- internals ---------------------------------------------------------------

  private emitProgress(p: ScanProgress): void {
    for (const cb of this.progressListeners) cb(p);
  }

  private onFsChange(e: { kind: "upsert" | "remove"; path: string }): void {
    if (e.kind === "remove") {
      this.db.deleteByPath(e.path);
      return;
    }
    if (extname(e.path).toLowerCase() === ".lrc") {
      void this.refreshSidecarLyrics(e.path);
      return;
    }
    void this.scan([e.path]);
  }

  /** A .lrc file appeared or changed: update the song it sits beside. */
  private async refreshSidecarLyrics(lrcPath: string): Promise<void> {
    const base = lrcPath.slice(0, -extname(lrcPath).length);
    for (const ext of AUDIO_EXTENSIONS) await this.syncSidecarLyrics(base + ext);
  }

  /**
   * Copy a song's .lrc sidecar into the index when it differs from what the
   * last scan read, so lyrics dropped beside an unchanged song still show.
   */
  private async syncSidecarLyrics(audioPath: string): Promise<void> {
    const stored = this.db.scannedLyrics(audioPath);
    if (stored === undefined) return;
    const lyrics = await readLyricsFile(sidecarLyricsPath(audioPath));
    if (lyrics !== null && lyrics !== stored) this.db.setScannedLyrics(audioPath, lyrics);
  }

  private async runScan(paths: string[]): Promise<void> {
    if (this.disposed) return;
    // Two passes: enumerate targets first so progress can report a total.
    const files: string[] = [];
    for (const root of paths) {
      for await (const f of this.scanner.walkAudioFiles(root)) files.push(f);
    }
    const total = files.length;
    this.emitProgress({ phase: "scanning", scanned: 0, total });
    let scanned = 0;
    const seen = new Set(files);
    for (const f of files) {
      const st = await this.fileStampUnchanged(f);
      if (st) {
        await this.syncSidecarLyrics(f);
        scanned += 1;
        continue;
      }
      const rec = await this.scanner.scanFile(f);
      if (rec !== null) this.db.upsertTrack(rec);
      scanned += 1;
      if (scanned % this.batchSize === 0) {
        this.emitProgress({ phase: "scanning", scanned, total, currentPath: f });
        await new Promise((r) => setImmediate(r));
      }
    }
    // Prune indexed files that disappeared under a scanned root.
    if (paths.length > 0) {
      for (const p of this.db.allPaths()) {
        if (!seen.has(p) && paths.some((root) => p.startsWith(withSep(root)))) {
          this.db.deleteByPath(p);
        }
      }
    }
    this.emitProgress({
      phase: this.watcher !== null ? "watching" : "idle",
      scanned: total,
      total,
    });
  }

  /** True when the file's mtime+size match the index (skip re-parse). */
  private async fileStampUnchanged(path: string): Promise<boolean> {
    const stamp = this.db.fileStamp(path);
    if (stamp === null) return false;
    const st = await stat(path).catch(() => null);
    if (st === null) return false;
    return Math.round(st.mtimeMs) === stamp.mtimeMs && st.size === stamp.size;
  }
}

/** Append a trailing separator so `/music` does not match `/music2/x`. */
function withSep(root: string): string {
  // Windows roots use "\"; POSIX uses "/". Accept either trailing sep.
  return root.endsWith("/") || root.endsWith("\\") ? root : root + sep;
}

/** Default chokidar-backed watcher factory for production wiring. */
export const chokidarWatcherFactory: CreateWatcher = (roots, onFsChange) => {
  const w: FSWatcher = watch(roots, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    depth: 12,
  });
  w.on("add", (p) => onFsChange({ kind: "upsert", path: p }));
  w.on("change", (p) => onFsChange({ kind: "upsert", path: p }));
  w.on("unlink", (p) => onFsChange({ kind: "remove", path: p }));
  return {
    close: () => w.close(),
  };
};
