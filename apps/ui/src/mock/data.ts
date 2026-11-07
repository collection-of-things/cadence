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

type ArtStyle = 'orbs' | 'sun' | 'figure' | 'grid' | 'type' | 'stripes' | 'halftone';
const STYLES: ArtStyle[] = ['orbs', 'sun', 'figure', 'grid', 'type', 'stripes', 'halftone'];

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Deterministic poster-like cover art for the mock library. Each style
 * mimics a common album-art composition so screenshots exercise real
 * palette extraction and contrast, not just soft gradients.
 */
export function svgArtwork(seed: number, style?: ArtStyle, label?: string): string {
  const rng = mulberry32(seed);
  const kind = style ?? STYLES[seed % STYLES.length]!;
  const h1 = Math.floor(rng() * 360);
  const h2 = (h1 + 30 + Math.floor(rng() * 60)) % 360;
  const h3 = (h1 + 180 + Math.floor(rng() * 40)) % 360;
  const body: string[] = [];
  const defs: string[] = [];
  switch (kind) {
    case 'sun': {
      defs.push(`<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h1} 70% 62%)"/><stop offset="1" stop-color="hsl(${h2} 75% 38%)"/></linearGradient>`);
      body.push(`<rect width="600" height="600" fill="url(#sky)"/>`);
      body.push(`<circle cx="${250 + Math.floor(rng() * 100)}" cy="300" r="150" fill="hsl(${h1 + 20} 95% 82%)"/>`);
      body.push(`<rect y="360" width="600" height="240" fill="hsl(${h2} 55% 18%)"/>`);
      for (let i = 0; i < 6; i++) body.push(`<rect y="${372 + i * 22}" x="${60 + i * 18}" width="${480 - i * 36}" height="5" rx="2.5" fill="hsl(${h1 + 20} 95% 82%)" opacity="${(0.6 - i * 0.09).toFixed(2)}"/>`);
      break;
    }
    case 'figure': {
      defs.push(`<radialGradient id="glow" cx="0.45" cy="0.4" r="0.7"><stop offset="0" stop-color="hsl(${h1} 85% 46%)"/><stop offset="1" stop-color="hsl(${h1} 80% 8%)"/></radialGradient>`);
      defs.push(`<filter id="soft"><feGaussianBlur stdDeviation="2.5"/></filter>`);
      body.push(`<rect width="600" height="600" fill="url(#glow)"/>`);
      body.push(`<g filter="url(#soft)" fill="hsl(${h1 + 25} 40% 88%)"><path d="M210 140 C300 60 420 120 400 220 C385 300 300 300 330 380 C350 440 300 520 250 540 C270 470 230 420 190 380 C140 330 150 220 210 140Z" opacity=".92"/><path d="M380 210 C460 230 500 300 470 340 C430 300 400 290 360 280Z" opacity=".7"/></g>`);
      body.push(`<ellipse cx="300" cy="300" rx="60" ry="90" fill="hsl(${h1} 60% 10%)" opacity=".55" filter="url(#soft)"/>`);
      break;
    }
    case 'grid': {
      body.push(`<rect width="600" height="600" fill="hsl(${h1} 12% 12%)"/>`);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        if ((x + y) % 2) continue;
        body.push(`<rect x="${x * 75 + 6}" y="${y * 75 + 6}" width="63" height="63" rx="4" fill="hsl(${h1} 18% ${58 + Math.floor(rng() * 14)}%)" transform="rotate(45 ${x * 75 + 37} ${y * 75 + 37})" opacity=".9"/>`);
      }
      body.push(`<circle cx="${280 + Math.floor(rng() * 40)}" cy="${300 + Math.floor(rng() * 40)}" r="22" fill="hsl(${h3} 85% 50%)"/>`);
      break;
    }
    case 'type': {
      defs.push(`<linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1} 95% 60%)"/><stop offset="1" stop-color="hsl(${h2} 95% 45%)"/></linearGradient>`);
      body.push(`<rect width="600" height="600" fill="url(#t)"/>`);
      const words = (label ?? 'Cadence').split(' ').slice(0, 3);
      words.forEach((w, i) => body.push(`<text x="300" y="${300 - (words.length - 1) * 55 + i * 110 + 36}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="800" font-size="${Math.min(120, Math.floor(1000 / Math.max(5, w.length)))}" fill="hsl(${h1} 100% 97%)" text-anchor="middle" letter-spacing="-3">${esc(w)}</text>`));
      break;
    }
    case 'stripes': {
      body.push(`<rect width="600" height="600" fill="hsl(${h1} 30% 10%)"/>`);
      for (let i = 0; i < 9; i++) {
        const hue = i % 2 ? h1 : h2;
        body.push(`<rect x="${i * 66 + 6}" y="${120 + Math.floor(rng() * 80)}" width="48" height="${260 + Math.floor(rng() * 120)}" rx="24" fill="hsl(${hue} 75% ${48 + i * 3}%)" opacity=".92"/>`);
      }
      break;
    }
    case 'halftone': {
      body.push(`<rect width="600" height="600" fill="hsl(${h1} 14% 9%)"/>`);
      for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
        const d = Math.abs(x - 14 - y * 0.35 + Math.sin(y / 4) * 4);
        const r = Math.max(0, 6.2 - d * 0.55) + rng() * 0.6;
        if (r > 0.6) body.push(`<circle cx="${x * 15 + 7}" cy="${y * 15 + 7}" r="${r.toFixed(1)}" fill="hsl(${h1} 60% 84%)"/>`);
      }
      break;
    }
    default: {
      defs.push(`<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1} 55% 24%)"/><stop offset="1" stop-color="hsl(${h2} 60% 14%)"/></linearGradient>`);
      body.push(`<rect width="600" height="600" fill="url(#g)"/>`);
      for (let i = 0; i < 5; i++) {
        body.push(`<circle cx="${Math.floor(rng() * 600)}" cy="${Math.floor(rng() * 600)}" r="${Math.floor(80 + rng() * 260)}" fill="hsl(${i % 2 ? h2 : h3} 70% ${45 + Math.floor(rng() * 20)}%)" opacity="${(0.18 + rng() * 0.25).toFixed(2)}"/>`);
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">` +
    `<defs>${defs.join('')}</defs>${body.join('')}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface AlbumSpec {
  key: string;
  title: string;
  artist: string;
  year: number;
  route: TrackRef['route'];
  provider: TrackRef['provider'];
  genre: string[];
  art: ArtStyle;
  format?: string;
}

// The first five keep their original order so queue fixtures stay stable.
const ALBUMS: AlbumSpec[] = [
  { key: 'midnight-cartography', title: 'Midnight Cartography', artist: 'Aurora Fields', year: 2021, route: 'local', provider: 'local', format: 'flac', genre: ['Indie', 'Alternative'], art: 'figure' },
  { key: 'glass-meridian', title: 'Glass Meridian', artist: 'Novacane Hearts', year: 2023, route: 'spotify-librespot', provider: 'spotify', genre: ['Electronic', 'Ambient'], art: 'grid' },
  { key: 'verdant-static', title: 'Verdant Static', artist: 'Moss Cathedral', year: 2020, route: 'spotify-web', provider: 'spotify', genre: ['Indie', 'Alternative'], art: 'halftone' },
  { key: 'aurora-live', title: 'Aurora Borealis Live', artist: 'Fjordline', year: 2024, route: 'apple-musickit', provider: 'apple', genre: ['Electronic', 'Ambient'], art: 'sun' },
  { key: 'slow-machines', title: 'Slow Machines', artist: 'Tessellate', year: 2022, route: 'youtube-music', provider: 'youtube', genre: ['Indie', 'Alternative'], art: 'stripes' },
  { key: 'heavy-sun', title: 'Heavy Sun', artist: 'Orchard Kid', year: 2025, route: 'local', provider: 'local', format: 'flac', genre: ['Hip-Hop'], art: 'type' },
  { key: 'ember-rites', title: 'Ember Rites', artist: 'Hollow Saints', year: 2025, route: 'local', provider: 'local', format: 'flac', genre: ['Rock', 'Alternative'], art: 'figure' },
  { key: 'paper-lanterns', title: 'Paper Lanterns', artist: 'Mira Lowe', year: 2022, route: 'local', provider: 'local', format: 'mp3', genre: ['Pop'], art: 'orbs' },
  { key: 'ghosttide', title: 'Ghosttide', artist: 'Venture Lines', year: 2025, route: 'local', provider: 'local', format: 'flac', genre: ['Indie', 'Alternative'], art: 'halftone' },
  { key: 'northern-glass', title: 'Northern Glass', artist: 'Coastal Static', year: 2023, route: 'local', provider: 'local', format: 'flac', genre: ['Electronic', 'Ambient'], art: 'sun' },
];

const LYRIC_LINES = [
  'Signal on the wire', 'Carry it through the night', 'Static in the distance', 'Everything is fine',
  'Hold the line, hold the line', 'We are almost there', 'Neon on the water', 'Voices in the air',
  'I kept the porch light on for you', 'Counting cars along the avenue', 'Every window hums a different tune',
  'And none of them are you', 'Tell me what you want from me', 'Tell me what you need',
  'I would give you anything you ask for', 'Even the part of me I keep', 'Hold the line, hold the line',
  'We are almost there', 'Paper boats on a silver tide', 'Drifting out to the other side',
  'Everything is quiet now', 'Everything is light',
];

/** Demo synced lyrics (LRC), ~5s per line, looped to cover a full track. */
function demoLrc(durationMs: number): string {
  const rows: string[] = [];
  for (let t = 500, i = 0; t < durationMs - 2000; t += 4600 + (i % 3) * 700, i++) {
    const m = Math.floor(t / 60000);
    const s = ((t % 60000) / 1000).toFixed(2).padStart(5, '0');
    rows.push(`[${String(m).padStart(2, '0')}:${s}]${LYRIC_LINES[i % LYRIC_LINES.length]}`);
  }
  return rows.join('\n');
}

export function makeLibrary(): { tracks: TrackRef[]; albums: LibraryAlbum[] } {
  const tracks: TrackRef[] = [];
  const albums: LibraryAlbum[] = [];
  ALBUMS.forEach((spec, ai) => {
    const rng = mulberry32(ai * 7919 + 13);
    const artwork = { url: svgArtwork(ai * 131 + 7, spec.art, spec.title), width: 600, height: 600 };
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
              path: `/music/${spec.artist}/${spec.title}/${String(i + 1).padStart(2, '0')} ${title}.${spec.format}`,
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
        genre: spec.genre,
        artwork,
        source,
        ...(spec.route === 'local' ? { replayGainDb: -6.2 + rng() * 3 } : {}),
        ...(i % 4 !== 3 ? { lyrics: demoLrc(durationMs) } : {}),
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
