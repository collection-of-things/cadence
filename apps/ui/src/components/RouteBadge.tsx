import type { ProviderId, RouteId } from '@cadence/protocol';

const PROVIDER_META: Record<ProviderId, { label: string }> = {
  local: { label: 'LOCAL' },
  spotify: { label: 'SPOTIFY' },
  apple: { label: 'APPLE' },
  youtube: { label: 'YOUTUBE' },
};

export function providerForRoute(route: RouteId): ProviderId {
  if (route.startsWith('spotify')) return 'spotify';
  if (route.startsWith('apple')) return 'apple';
  if (route.startsWith('youtube')) return 'youtube';
  return 'local';
}

const ROUTE_LABELS: Record<RouteId, string> = {
  local: 'Local files',
  'spotify-librespot': 'Spotify Connect',
  'spotify-web': 'Spotify Web Player',
  'apple-musickit': 'Apple Music',
  'youtube-music': 'YouTube Music',
};

export function routeLabel(route: RouteId): string {
  return ROUTE_LABELS[route];
}

export function RouteBadge({ provider, title }: { provider: ProviderId; title?: string }) {
  return (
    <span className={`route-badge rb-${provider}`} title={title}>
      {PROVIDER_META[provider].label}
    </span>
  );
}
