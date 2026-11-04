import type { QueueState, RouteId } from "@cadence/protocol";

/**
 * The coordinator's settings-file section. Restored at startup to bring back
 * queue + position WITHOUT autoplay — nothing is loaded into an engine until
 * the user presses play.
 */
export interface PersistedPlayback {
  readonly version: 1;
  readonly queue: QueueState;
  readonly positionMs: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly fidelityMode: boolean;
  readonly volumeByRoute: Partial<Record<RouteId, number>>;
}

const ROUTES: ReadonlySet<string> = new Set([
  "local",
  "spotify-librespot",
  "spotify-web",
  "apple-musickit",
  "youtube-music",
]);

function isQueueState(u: unknown): u is QueueState {
  if (typeof u !== "object" || u === null) return false;
  const q = u as Record<string, unknown>;
  if (q.owner !== "coordinator" && q.owner !== "provider") return false;
  if (!Array.isArray(q.items)) return false;
  if (typeof q.currentIndex !== "number") return false;
  for (const item of q.items) {
    if (typeof item !== "object" || item === null) return false;
    const it = item as Record<string, unknown>;
    if (typeof it.queueId !== "string" || typeof it.track !== "object" || it.track === null) {
      return false;
    }
  }
  return true;
}

/** Parse the settings section; null when absent, wrong version, or corrupt. */
export function parsePersistedPlayback(u: unknown): PersistedPlayback | null {
  if (typeof u !== "object" || u === null) return null;
  const p = u as Record<string, unknown>;
  if (p.version !== 1 || !isQueueState(p.queue)) return null;
  const volumeByRoute: Partial<Record<RouteId, number>> = {};
  if (typeof p.volumeByRoute === "object" && p.volumeByRoute !== null) {
    for (const [route, vol] of Object.entries(p.volumeByRoute as Record<string, unknown>)) {
      if (ROUTES.has(route) && typeof vol === "number" && Number.isFinite(vol)) {
        volumeByRoute[route as RouteId] = Math.min(Math.max(vol, 0), 1.5);
      }
    }
  }
  return {
    version: 1,
    queue: p.queue,
    positionMs: typeof p.positionMs === "number" && Number.isFinite(p.positionMs) ? p.positionMs : 0,
    volume: typeof p.volume === "number" && Number.isFinite(p.volume) ? Math.min(Math.max(p.volume, 0), 1) : 1,
    muted: p.muted === true,
    fidelityMode: p.fidelityMode === true,
    volumeByRoute,
  };
}
