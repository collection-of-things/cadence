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

export function RouteBadge({ provider, title }: { provider: ProviderId; title?: string }) {
  return (
    <span className={`route-badge rb-${provider}`} title={title}>
      {PROVIDER_META[provider].label}
    </span>
  );
}
