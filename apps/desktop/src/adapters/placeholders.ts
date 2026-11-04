import type {
  AdapterEvent,
  PlaybackLease,
  QueueItem,
  RouteAdapter,
  RouteCapabilities,
  RouteId,
} from "@cadence/protocol";

/**
 * Honest placeholder adapters for provider routes whose real implementations
 * land in src/adapters/providers/ (maintained by the lead). They report what
 * is actually true today: the route exists, its engine is provider-side, PCM
 * access is unverified, visuals are artwork-driven, and playback is not
 * available. Registering them keeps capability fan-in complete and gives the
 * registry its final shape — the real classes drop in via registry.register().
 */

/** A provider route that has no adapter implementation yet was asked to play. */
export class ProviderRoutePending extends Error {
  readonly _tag = "ProviderRoutePending" as const;
  constructor(
    readonly route: RouteId,
    message: string,
  ) {
    super(message);
  }
}

interface PlaceholderSpec {
  readonly state: RouteCapabilities["state"];
  readonly stateDetail: string;
  readonly notes: string[];
}

const PLACEHOLDER_SPECS: Partial<Record<RouteId, PlaceholderSpec>> = {
  "youtube-music": {
    state: "unauthenticated",
    stateDetail: "YouTube Music adapter pending; sign-in opens an authenticated music.youtube.com player in a sandboxed view.",
    notes: [
      "Planned: authenticated music.youtube.com player for playback, InnerTube for catalog.",
      "PCM/EQ access via Web Audio varies per track and runtime — not established.",
      "Provider-owned queue; next-item mirroring only when provider state confirms it.",
    ],
  },
  "apple-musickit": {
    state: "unauthenticated",
    stateDetail: "Apple Music adapter pending; sign-in runs MusicKit JS in an isolated view backed by a developer-token service.",
    notes: [
      "Planned: MusicKit JS playback in an isolated ECS view.",
      "Browser playback owns the stream; PCM, EQ, lossless and gapless are not established.",
      "Provider-owned queue.",
    ],
  },
  "spotify-librespot": {
    state: "unavailable",
    stateDetail: "Spotify librespot session integration is pending (Premium account required).",
    notes: [
      "Planned: librespot session feeding decoded PCM into the Cadence graph (EQ + real visuals).",
      "Audio-key refusal can affect accounts after login succeeds — failures stay local to this route.",
      "Will use the coordinator-owned queue and the PcmStreamSink interface once implemented.",
    ],
  },
  "spotify-web": {
    state: "unauthenticated",
    stateDetail: "Spotify web-player fallback pending; packaged DRM playback is unproven.",
    notes: [
      "Fallback route for accounts the librespot route cannot serve.",
      "Provider-owned queue; PCM access unknown.",
    ],
  },
};

/**
 * Build a placeholder RouteAdapter for a provider route. Playback methods
 * reject with ProviderRoutePending — the coordinator maps that to a
 * route-local error event and preserves the queue.
 */
export function makePlaceholderAdapter(route: RouteId): RouteAdapter {
  const spec = PLACEHOLDER_SPECS[route] ?? {
    state: "unavailable" as const,
    stateDetail: "Adapter not implemented.",
    notes: ["No adapter implementation is registered for this route."],
  };
  const listeners = new Set<(e: AdapterEvent) => void>();
  const pending = (op: string): ProviderRoutePending =>
    new ProviderRoutePending(route, `${op} is not available for route "${route}" yet`);
  return {
    route,
    capabilities: () =>
      Promise.resolve({
        route,
        state: spec.state,
        stateDetail: spec.stateDetail,
        playback: {
          engine: "provider-engine",
          canPlay: false,
          canPause: false,
          canSeek: false,
          canNextPrevious: false,
          gapless: "unknown",
          exclusiveOutput: "unknown",
        },
        audio: { pcmAccess: "unknown", eq: "unknown", replayGain: "unknown" },
        visuals: { kind: "ambient" },
        notes: [...spec.notes],
      }),
    prepare: () => Promise.resolve(),
    play: (_item: QueueItem, _lease: PlaybackLease) => Promise.reject(pending("play")),
    pause: () => Promise.reject(pending("pause")),
    resume: () => Promise.reject(pending("resume")),
    stop: () => Promise.resolve(), // nothing is sounding; teardown is trivially confirmed
    seek: (_lease: PlaybackLease, _positionMs: number) => Promise.reject(pending("seek")),
    setVolume: () => Promise.resolve(),
    releaseIdle: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    onEvent: (cb) => {
      listeners.add(cb);
    },
  };
}

/** Register honest placeholders for every provider route missing an adapter. */
export function providerRoutes(): RouteId[] {
  return Object.keys(PLACEHOLDER_SPECS) as RouteId[];
}
