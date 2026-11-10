import type { PlatformId, PlaybackSnapshot, ProviderId, RouteCapabilities, RouteId } from '@cadence/protocol';

/** The slice of UI state the route selectors read. */
interface RouteState {
  snapshot: PlaybackSnapshot;
  capabilities: RouteCapabilities[];
}

const ROUTE_LABELS: Record<RouteId, string> = {
  local: 'Local files',
  'spotify-librespot': 'Spotify Connect',
  'spotify-web': 'Spotify Web Player',
  'apple-musickit': 'Apple Music',
  'youtube-music': 'YouTube Music',
};

/** How each route state reads to the listener, and how loudly to show it. */
export const ROUTE_STATE_META: Record<RouteCapabilities['state'], { label: string; tone: 'ok' | 'warn' | 'dim' }> = {
  ready: { label: 'Ready', tone: 'ok' },
  unauthenticated: { label: 'Sign-in required', tone: 'warn' },
  unavailable: { label: 'Unavailable', tone: 'dim' },
  degraded: { label: 'Degraded', tone: 'warn' },
  error: { label: 'Error', tone: 'warn' },
};

/** Display name of a playback route. */
export function routeLabel(route: RouteId): string {
  return ROUTE_LABELS[route] ?? route;
}

/** The provider a route belongs to. */
export function providerForRoute(route: RouteId): ProviderId {
  if (route.startsWith('spotify')) return 'spotify';
  if (route.startsWith('apple')) return 'apple';
  if (route.startsWith('youtube')) return 'youtube';
  return 'local';
}

/** The route a platform's catalog and playback go through; null for local files. */
export function routeForPlatform(platform: PlatformId): RouteId | null {
  if (platform === 'apple') return 'apple-musickit';
  if (platform === 'youtube') return 'youtube-music';
  if (platform === 'spotify') return 'spotify-web';
  return null;
}

/** The route playing now: the lease holder, else the loaded track's route. */
export function activeRoute(s: RouteState): RouteId | undefined {
  return s.snapshot.lease?.route ?? s.snapshot.current?.track.route;
}

/** Capabilities of the route playing now. Undefined until that route reports. */
export function activeCapabilities(s: RouteState): RouteCapabilities | undefined {
  const route = activeRoute(s);
  return s.capabilities.find((c) => c.route === route);
}

/** A route's sign-in and health state. Undefined until the route reports. */
export function routeState(s: RouteState, route: RouteId | null): RouteCapabilities['state'] | undefined {
  return s.capabilities.find((c) => c.route === route)?.state;
}
