import type { ProviderId, RouteId } from '@cadence/protocol';
import { providerForRoute, routeLabel } from '../routes';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  local: 'Local',
  spotify: 'Spotify',
  apple: 'Apple Music',
  youtube: 'YouTube',
};

/** Small provider tag for the route a track plays through. */
export function RouteBadge({ route }: { route: RouteId }) {
  const provider = providerForRoute(route);
  return (
    <span className={`route-badge rb-${provider}`} title={routeLabel(route)}>
      {PROVIDER_LABELS[provider]}
    </span>
  );
}
