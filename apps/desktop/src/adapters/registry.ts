import type {
  AdapterEvent,
  RouteAdapter,
  RouteCapabilities,
  RouteId,
} from "@cadence/protocol";

/**
 * Registry of route adapters, keyed by route. The lead's provider adapters
 * (src/adapters/providers/) are registered here at composition time; until
 * then the placeholder stubs in src/adapters/placeholders.ts hold their
 * routes so the capability fan-in still reports every route honestly.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<RouteId, RouteAdapter>();

  /** Register an adapter for its route. Throws on duplicate registration. */
  register(adapter: RouteAdapter): void {
    if (this.adapters.has(adapter.route)) {
      throw new Error(`AdapterRegistry: duplicate adapter for route "${adapter.route}"`);
    }
    this.adapters.set(adapter.route, adapter);
  }

  /** Look up the adapter for a route; undefined when none is registered. */
  get(route: RouteId): RouteAdapter | undefined {
    return this.adapters.get(route);
  }

  /** All registered adapters, in registration order. */
  list(): RouteAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * Wire `adapter.onEvent` for every registered adapter into one sink so the
   * coordinator sees (route, event) pairs.
   */
  subscribeAll(cb: (route: RouteId, e: AdapterEvent) => void): void {
    for (const adapter of this.adapters.values()) {
      const route = adapter.route;
      adapter.onEvent((e) => cb(route, e));
    }
  }

  /**
   * Fan-in capability records from all adapters. An adapter whose
   * capabilities() call fails yields an honest "error" record — one broken
   * adapter must not take the rest down.
   */
  async capabilities(): Promise<RouteCapabilities[]> {
    return Promise.all(
      this.list().map(async (adapter) => {
        try {
          return await adapter.capabilities();
        } catch (cause) {
          return errorCapabilities(adapter.route, cause);
        }
      }),
    );
  }
}

/** Synthetic capability record for an adapter that failed to report. */
function errorCapabilities(route: RouteId, cause: unknown): RouteCapabilities {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    route,
    state: "error",
    stateDetail: `capabilities() failed: ${detail}`,
    playback: {
      engine: "none",
      canPlay: false,
      canPause: false,
      canSeek: false,
      canNextPrevious: false,
      gapless: "unknown",
      exclusiveOutput: "unknown",
    },
    audio: { pcmAccess: "unknown", eq: "unknown", replayGain: "unknown" },
    visuals: { kind: "ambient" },
    notes: ["This route could not report capabilities."],
  };
}
