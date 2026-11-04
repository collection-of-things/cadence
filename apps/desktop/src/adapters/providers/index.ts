/**
 * Provider route adapters. Each is a RouteAdapter from @cadence/protocol;
 * the coordinator registers them alongside the local adapter. All failures
 * stay local to their route; capability records distinguish unknown from
 * unsupported and unauthenticated from unavailable.
 */

export { ProviderSession } from "./provider-session.js";
export { ProviderViewAdapter } from "./provider-adapter-base.js";
export { YouTubeMusicAdapter } from "./youtube-music.js";
export { AppleMusicKitAdapter, type AppleMusicAdapterDeps } from "./apple-musickit.js";
export {
  SpotifyLibrespotAdapter,
  type LibrespotAdapterDeps,
  type PcmStreamSink,
} from "./spotify-librespot.js";
export { SpotifyWebAdapter } from "./spotify-web.js";

import type { RouteAdapter } from "@cadence/protocol";
import { YouTubeMusicAdapter } from "./youtube-music.js";
import { AppleMusicKitAdapter, type AppleMusicAdapterDeps } from "./apple-musickit.js";
import { SpotifyLibrespotAdapter, type PcmStreamSink } from "./spotify-librespot.js";
import { SpotifyWebAdapter } from "./spotify-web.js";

export interface ProviderAdaptersDeps {
  /** PCM sink into the shared audio graph (for the librespot route). */
  pcmSink: PcmStreamSink;
  apple?: AppleMusicAdapterDeps;
}

/** Construct all provider route adapters. Register on the adapter registry. */
export function createProviderAdapters(deps: ProviderAdaptersDeps): RouteAdapter[] {
  return [
    new YouTubeMusicAdapter(),
    new AppleMusicKitAdapter(deps.apple ?? {}),
    new SpotifyLibrespotAdapter({ sink: deps.pcmSink }),
    new SpotifyWebAdapter(),
  ];
}
