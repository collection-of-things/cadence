import type { QueueItem, QueueState, TrackRef } from '@cadence/protocol';

/** Queue items in the order they play (shuffle applied). */
export function playOrder(q: QueueState): QueueItem[] {
  if (q.shuffle && q.shuffleOrder !== undefined && q.shuffleOrder.length === q.items.length) {
    return q.shuffleOrder.flatMap((i) => {
      const item = q.items[i];
      return item === undefined ? [] : [item];
    });
  }
  return q.items;
}

/** Index of the playing item within `playOrder(q)`, or -1. */
export function orderIndexOf(q: QueueState, queueId: string | undefined): number {
  if (queueId === undefined) return -1;
  return playOrder(q).findIndex((i) => i.queueId === queueId);
}

/** A local library file the computer can stream to the phone. */
export function isStreamable(track: TrackRef): boolean {
  return track.route === 'local' && track.source.kind === 'file';
}

export function mediaUri(base: string, track: TrackRef, token: string): string {
  return `${base}/v1/media/${encodeURIComponent(track.id)}?t=${encodeURIComponent(token)}`;
}

/** Artwork as a URI the phone can load: LAN paths get the base and token. */
export function artworkUri(base: string | null, track: TrackRef, token: string): string | null {
  const url = track.artwork?.url;
  if (url === undefined) return null;
  if (url.startsWith('/')) return base === null ? null : `${base}${url}?t=${encodeURIComponent(token)}`;
  return /^https?:\/\//.test(url) ? url : null;
}

export interface ProviderLink {
  readonly label: string;
  readonly url: string;
}

/**
 * Where a streaming track opens on the phone. These hand off to the
 * service's own app, so playback there uses that app and its account.
 */
export function providerLink(track: TrackRef, positionMs: number): ProviderLink | null {
  if (track.source.kind !== 'provider') return null;
  const { providerItemId, uri, catalogId } = track.source;
  const seconds = Math.floor(positionMs / 1000);
  switch (track.provider) {
    case 'spotify': {
      const id = uri?.startsWith('spotify:track:') ? uri.slice('spotify:track:'.length) : providerItemId;
      return { label: 'Open in Spotify', url: `https://open.spotify.com/track/${encodeURIComponent(id)}` };
    }
    case 'apple': {
      const id = catalogId ?? (uri?.startsWith('am:song:') ? uri.slice('am:song:'.length) : null);
      // Library-only songs (i.xxxx ids) have no public catalog page.
      if (id === null || id.startsWith('i.')) return null;
      return { label: 'Open in Apple Music', url: `https://music.apple.com/song/${encodeURIComponent(id)}` };
    }
    case 'youtube':
      return {
        label: 'Open in YouTube Music',
        url: `https://music.youtube.com/watch?v=${encodeURIComponent(providerItemId)}${seconds > 0 ? `&t=${seconds}` : ''}`,
      };
    case 'local':
      return null;
    default: {
      const _exhaustive: never = track.provider;
      return _exhaustive;
    }
  }
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function artistLine(track: TrackRef): string {
  return track.artists.map((a) => a.name).join(', ');
}
