/**
 * Shared base for provider-engine route adapters (hidden ECS views).
 * Handles the RouteAdapter contract bookkeeping — event sink, capability
 * caching, lease checks — so each provider file stays small.
 */

import type {
  AdapterEvent,
  PlaybackLease,
  QueueItem,
  RouteAdapter,
  RouteCapabilities,
  RouteId,
} from "@cadence/protocol";

export abstract class ProviderViewAdapter implements RouteAdapter {
  abstract readonly route: RouteId;
  protected sink: ((e: AdapterEvent) => void) | null = null;
  protected lastError: string | undefined;

  onEvent(cb: (e: AdapterEvent) => void): void {
    this.sink = cb;
  }

  protected emit(e: AdapterEvent): void {
    this.sink?.(e);
  }

  protected error(message: string, retriable: boolean, code?: string): void {
    this.lastError = message;
    this.emit({ kind: "error", message, retriable, ...(code ? { code } : {}) });
  }

  /** Default: provider views that can play can also pause/seek/skip. */
  protected baseCapabilities(patch: Partial<RouteCapabilities>): RouteCapabilities {
    return {
      route: this.route,
      state: "unauthenticated",
      playback: {
        engine: "provider-engine",
        canPlay: true,
        canPause: true,
        canSeek: true,
        canNextPrevious: true,
        gapless: "unknown",
        exclusiveOutput: "no",
      },
      audio: { pcmAccess: "unknown", eq: "unknown", replayGain: "no" },
      visuals: { kind: "ambient" },
      notes: [],
      ...patch,
    };
  }

  abstract capabilities(): Promise<RouteCapabilities>;
  abstract prepare(): Promise<void>;
  abstract play(item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }): Promise<void>;
  abstract pause(lease: PlaybackLease): Promise<void>;
  abstract resume(lease: PlaybackLease): Promise<void>;
  abstract stop(lease: PlaybackLease): Promise<void>;
  abstract seek(lease: PlaybackLease, positionMs: number): Promise<void>;
  abstract setVolume(volume: number): Promise<void>;
  abstract dispose(): Promise<void>;
}
