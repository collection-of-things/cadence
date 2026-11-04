import type { LibraryAlbum, RouteCapabilities, TrackRef } from '@cadence/protocol';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES_A = ['Midnight', 'Glass', 'Verdant', 'Slow', 'Electric', 'Pale', 'Golden', 'Silent', 'Neon', 'Paper'];
const TITLES_B = ['Cartography', 'Meridian', 'Static', 'Machines', 'Hymn', 'Harbor', 'Signal', 'Weather', 'Bloom', 'Arcade'];
const TITLES_C = ['II', 'Reprise', 'Interlude', 'Dawn Mix', 'for Two', 'Overture', 'in Rain', 'Epilogue'];

export function svgArtwork(seed: number): string {
  const rng = mulberry32(seed);
  const h1 = Math.floor(rng() * 360);
  const h2 = (h1 + 40 + Math.floor(rng() * 120)) % 360;
  const h3 = (h1 + 180 + Math.floor(rng() * 60)) % 360;
  const shapes: string[] = [];
  for (let i = 0; i < 5; i++) {
    const cx = Math.floor(rng() * 600);
    const cy = Math.floor(rng() * 600);
    const r = Math.floor(80 + rng() * 260);
    const hue = i % 2 ? h2 : h3;
    shapes.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${hue} 70% ${45 + Math.floor(rng() * 20)}%)" opacity="${(0.12 + rng() * 0.2).toFixed(2)}"/>`,
    );
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h1} 55% 22%)"/><stop offset="1" stop-color="hsl(${h2} 60% 14%)"/>` +
    `</linearGradient></defs><rect width="600" height="600" fill="url(#g)"/>${shapes.join('')}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface AlbumSpec {
  key: string;
  title: string;
  artist: string;
  year: number;
  route: TrackRef['route'];
  provider: TrackRef['provider'];
  format?: string;
}

const ALBUMS: AlbumSpec[] = [
  { key: 'midnight-cartography', title: 'Midnight Cartography', artist: 'Aurora Fields', year: 2021, route: 'local', provider: 'local', format: 'flac' },
  { key: 'glass-meridian', title: 'Glass Meridian', artist: 'Novacane Hearts', year: 2023, route: 'spotify-librespot', provider: 'spotify' },
  { key: 'verdant-static', title: 'Verdant Static', artist: 'Moss Cathedral', year: 2020, route: 'spotify-web', provider: 'spotify' },
  { key: 'aurora-live', title: 'Aurora Borealis Live', artist: 'Fjordline', year: 2024, route: 'apple-musickit', provider: 'apple' },
  { key: 'slow-machines', title: 'Slow Machines', artist: 'Tessellate', year: 2022, route: 'youtube-music', provider: 'youtube' },
];

export function makeLibrary(): { tracks: TrackRef[]; albums: LibraryAlbum[] } {
  const tracks: TrackRef[] = [];
  const albums: LibraryAlbum[] = [];
  ALBUMS.forEach((spec, ai) => {
    const rng = mulberry32(ai * 7919 + 13);
    const artwork = { url: svgArtwork(ai * 131 + 7), width: 600, height: 600 };
    const n = 7 + (ai % 3); // 7-9 tracks per album
    for (let i = 0; i < n; i++) {
      const title =
        `${TITLES_A[Math.floor(rng() * TITLES_A.length)]} ${TITLES_B[Math.floor(rng() * TITLES_B.length)]}` +
        (rng() < 0.3 ? ` ${TITLES_C[Math.floor(rng() * TITLES_C.length)]}` : '');
      const durationMs = Math.floor((150 + rng() * 210) * 1000);
      const source: TrackRef['source'] =
        spec.route === 'local'
          ? {
              kind: 'file',
              path: `/home/xdd/Music/${spec.artist}/${spec.title}/${String(i + 1).padStart(2, '0')} ${title}.${spec.format}`,
              ...(spec.format ? { format: spec.format } : {}),
            }
          : { kind: 'provider', providerItemId: `${spec.key}-${i + 1}`, uri: `${spec.provider}:${spec.key}:${i + 1}` };
      tracks.push({
        id: `${spec.route}:${spec.key}-${i + 1}`,
        route: spec.route,
        provider: spec.provider,
        title,
        artists: [{ name: spec.artist }],
        album: spec.title,
        durationMs,
        trackNumber: i + 1,
        discNumber: 1,
        year: spec.year,
        genre: ai % 2 ? ['Electronic', 'Ambient'] : ['Indie', 'Alternative'],
        artwork,
        source,
        ...(spec.route === 'local' ? { replayGainDb: -6.2 + rng() * 3 } : {}),
        availability: 'available',
      });
    }
    albums.push({
      id: spec.key,
      title: spec.title,
      artist: spec.artist,
      year: spec.year,
      artwork,
      trackCount: n,
    });
  });
  return { tracks, albums };
}

export function makeCapabilities(): RouteCapabilities[] {
  return [
    {
      route: 'local',
      state: 'ready',
      playback: { engine: 'native-pcm', canPlay: true, canPause: true, canSeek: true, canNextPrevious: true, gapless: 'yes', exclusiveOutput: 'unknown' },
      audio: { pcmAccess: 'yes', eq: 'yes', replayGain: 'yes', qualityCeiling: 'up to 32-bit/192kHz lossless' },
      visuals: { kind: 'pcm-fft' },
      notes: ['Decoded into the shared Rust audio graph.'],
    },
    {
      route: 'spotify-librespot',
      state: 'ready',
      playback: { engine: 'native-pcm', canPlay: true, canPause: true, canSeek: true, canNextPrevious: true, gapless: 'unknown', exclusiveOutput: 'no' },
      audio: { pcmAccess: 'yes', eq: 'yes', replayGain: 'yes', qualityCeiling: 'Ogg Vorbis 320kbps' },
      visuals: { kind: 'pcm-fft' },
      notes: ['Premium account required. Audio-key refusals can still occur per track.'],
    },
    {
      route: 'spotify-web',
      state: 'unauthenticated',
      stateDetail: 'Sign in to Spotify to enable the web-player route.',
      playback: { engine: 'provider-engine', canPlay: false, canPause: false, canSeek: false, canNextPrevious: false, gapless: 'unknown', exclusiveOutput: 'no' },
      audio: { pcmAccess: 'no', eq: 'no', replayGain: 'unknown', qualityCeiling: 'AAC 256kbps' },
      visuals: { kind: 'ambient' },
      notes: ['Browser engine owns the stream; queue and transitions are provider-controlled.'],
    },
    {
      route: 'apple-musickit',
      state: 'degraded',
      stateDetail: 'Lossless unavailable on this build; playback falls back to AAC.',
      playback: { engine: 'provider-engine', canPlay: true, canPause: true, canSeek: true, canNextPrevious: true, gapless: 'unknown', exclusiveOutput: 'no' },
      audio: { pcmAccess: 'unknown', eq: 'no', replayGain: 'unknown', qualityCeiling: 'AAC 256kbps' },
      visuals: { kind: 'ambient' },
      notes: ['MusicKit playback runs in an isolated view.'],
    },
    {
      route: 'youtube-music',
      state: 'ready',
      playback: { engine: 'provider-engine', canPlay: true, canPause: true, canSeek: true, canNextPrevious: true, gapless: 'no', exclusiveOutput: 'no' },
      audio: { pcmAccess: 'unknown', eq: 'unknown', replayGain: 'unknown', qualityCeiling: 'Opus ~160kbps' },
      visuals: { kind: 'ambient' },
      notes: ['Next item is mirrored only when provider queue state confirms it.'],
    },
  ];
}
