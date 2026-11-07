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
  readonly replayGain: boolean;
  readonly volumeByRoute: Partial<Record<RouteId, number>>;
}

const ROUTES: ReadonlySet<string> = new Set([
  "local",
  "spotify-librespot",
  "spotify-web",
  "apple-musickit",
  "youtube-music",
]);

export function isTrack(u: unknown): boolean {
  if (typeof u !== "object" || u === null) return false;
  const t = u as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id.length === 0) return false;
  if (typeof t.route !== "string" || !ROUTES.has(t.route)) return false;
  if (typeof t.provider !== "string" || t.provider.length === 0) return false;
  if (typeof t.title !== "string") return false;
  if (
    !Array.isArray(t.artists) ||
    !t.artists.every(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as Record<string, unknown>).name === "string",
    )
  ) {
    return false;
  }
  if (typeof t.durationMs !== "number" || t.durationMs < 0) return false;
  if (
    t.availability !== "available" &&
    t.availability !== "unavailable" &&
    t.availability !== "unknown"
  ) {
    return false;
  }
  // Every route's engine reads track.source — a track without a usable
  // source is a crash at play time, not a valid restore.
  const src = t.source;
  if (typeof src !== "object" || src === null) return false;
  const kind = (src as Record<string, unknown>).kind;
  if (kind === "file") {
    return typeof (src as Record<string, unknown>).path === "string";
  }
  if (kind === "provider") {
    return typeof (src as Record<string, unknown>).providerItemId === "string";
  }
  return false;
}

function isQueueState(u: unknown): u is QueueState {
  if (typeof u !== "object" || u === null) return false;
  const q = u as Record<string, unknown>;
  if (q.owner !== "coordinator" && q.owner !== "provider") return false;
  if (!Array.isArray(q.items)) return false;
  if (typeof q.currentIndex !== "number" || !Number.isInteger(q.currentIndex)) return false;
  // -1 means "nothing selected": the only legal index on an empty queue,
  // and legitimate on a nonempty one too — insertNext/append on an idle
  // queue leave the index at -1 until the user starts playback.
  if (q.currentIndex < -1 || q.currentIndex >= q.items.length) return false;
  for (const item of q.items) {
    if (typeof item !== "object" || item === null) return false;
    const it = item as Record<string, unknown>;
    if (typeof it.queueId !== "string" || it.queueId === "" || !isTrack(it.track)) {
      return false;
    }
  }
  // Queue ops index and map into shuffleOrder — a present non-array is a
  // runtime crash regardless of the shuffle flag, and a live shuffle
  // needs a full permutation of the item indices.
  if (typeof q.shuffle !== "boolean") return false;
  if (q.shuffleOrder !== undefined) {
    if (
      !Array.isArray(q.shuffleOrder) ||
      !q.shuffleOrder.every((n) => typeof n === "number" && Number.isInteger(n))
    ) {
      return false;
    }
  }
  if (q.shuffle === true) {
    const items = q.items as unknown[];
    const order = q.shuffleOrder as number[] | undefined;
    if (
      order === undefined ||
      order.length !== items.length ||
      new Set(order).size !== order.length ||
      !order.every((n) => n >= 0 && n < items.length)
    ) {
      return false;
    }
  }
  if (q.repeat !== "off" && q.repeat !== "all" && q.repeat !== "one") return false;
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
    volume: typeof p.volume === "number" && Number.isFinite(p.volume) ? Math.min(Math.max(p.volume, 0), 1.5) : 1,
    muted: p.muted === true,
    fidelityMode: p.fidelityMode === true,
    replayGain: p.replayGain === true,
    volumeByRoute,
  };
}
