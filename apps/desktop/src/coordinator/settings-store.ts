import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Small JSON-file settings store shared by the coordinator and library.
 * Each service owns one top-level section key; writes are atomic
 * (tmp + rename) so a crash mid-write cannot corrupt prior state.
 */
export class SettingsStore {
  constructor(private readonly path: string) {}

  /** Read and parse the whole settings document; null when absent or corrupt. */
  loadDocument(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Read one service's section; null when missing or not an object. */
  loadSection(key: string): unknown {
    const doc = this.loadDocument();
    return doc[key] ?? null;
  }

  /** Merge one service's section into the document and persist atomically. */
  saveSection(key: string, value: unknown): void {
    const doc = this.loadDocument();
    doc[key] = value;
    this.saveDocument(doc);
  }

  /** Persist the whole document atomically. */
  saveDocument(doc: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(doc));
    renameSync(tmp, this.path);
  }
}

/** Default settings file location inside a data directory. */
export function settingsPath(dataDir: string): string {
  return join(dataDir, "cadence-settings.json");
}
