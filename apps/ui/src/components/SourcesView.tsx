import { useEffect, useRef, useState } from 'react';
import type { RouteCapabilities, RouteId, TrackRef } from '@cadence/protocol';
import { api, session } from '../app';
import { artistsLine, formatTime } from '../format';
import { useUi } from '../hooks';
import { NoteIcon, PlusIcon, SearchIcon } from '../icons';
import { providerForRoute, RouteBadge, routeLabel } from './RouteBadge';
import './controls.css';

const STATE_META: Record<RouteCapabilities['state'], { label: string; tone: 'ok' | 'warn' | 'dim' }> = {
  ready: { label: 'Ready', tone: 'ok' },
  unauthenticated: { label: 'Sign-in required', tone: 'warn' },
  unavailable: { label: 'Unavailable', tone: 'dim' },
  degraded: { label: 'Degraded', tone: 'warn' },
  error: { label: 'Error', tone: 'warn' },
};

/** IPC handler rejections arrive wrapped; keep the adapter's own message. */
function cleanIpcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function triChip(key: string, tri: 'yes' | 'no' | 'unknown', label: string) {
  if (tri === 'yes') return { key, label, tone: 'ok' as const };
  if (tri === 'unknown') return { key, label: `${label}?`, tone: 'dim' as const };
  return null;
}

const ENGINE_LABELS: Record<RouteCapabilities['playback']['engine'], string> = {
  'native-pcm': 'Native PCM',
  'provider-engine': 'Provider engine',
  none: 'No engine',
};

function RouteCard({ cap }: { cap: RouteCapabilities }) {
  const meta = STATE_META[cap.state];
  const chips = [
    {
      key: 'eng',
      label: ENGINE_LABELS[cap.playback.engine],
      tone: cap.playback.engine === 'none' ? ('dim' as const) : ('ok' as const),
    },
    triChip('gap', cap.playback.gapless, 'Gapless'),
    triChip('eq', cap.audio.eq, 'EQ'),
    triChip('pcm', cap.audio.pcmAccess, 'PCM'),
    triChip('rg', cap.audio.replayGain, 'ReplayGain'),
    cap.audio.qualityCeiling ? { key: 'q', label: cap.audio.qualityCeiling, tone: 'dim' as const } : null,
    { key: 'vis', label: cap.visuals.kind === 'pcm-fft' ? 'PCM FFT' : 'Ambient visuals', tone: 'dim' as const },
  ].filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <section className="src-route">
      <header className="src-route-head">
        <RouteBadge provider={providerForRoute(cap.route)} />
        <span className="src-route-name">{routeLabel(cap.route)}</span>
        <span className={`chip chip-${meta.tone} src-state`} title={cap.stateDetail}>
          <i className="src-dot" aria-hidden />
          {meta.label}
        </span>
      </header>
      {cap.stateDetail && <p className="src-route-detail">{cap.stateDetail}</p>}
      <div className="cap-chips">
        {chips.map((c) => (
          <span key={c.key} className={`chip chip-${c.tone}`}>
            {c.label}
          </span>
        ))}
      </div>
      {cap.notes.length > 0 && (
        <ul className="src-notes">
          {cap.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {cap.state === 'unauthenticated' && (
        <button className="btn src-signin" onClick={() => session.signInRoute(cap.route)}>
          Sign in
        </button>
      )}
    </section>
  );
}

function ProviderSearch({ caps }: { caps: RouteCapabilities[] }) {
  const searchable = caps.filter((c) => c.route !== 'local');
  const [route, setRoute] = useState<RouteId>('youtube-music');
  const [text, setText] = useState('');
  const [results, setResults] = useState<TrackRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = text.trim();
    setResults(null);
    setError(null);
    if (!q) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++seq.current;
    const t = setTimeout(() => {
      api.search
        .provider(route, q)
        .then((hits) => {
          if (seq.current !== id) return;
          setResults(hits);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (seq.current !== id) return;
          setError(cleanIpcError(e));
          setLoading(false);
        });
    }, 350);
    return () => clearTimeout(t);
  }, [text, route]);

  const active = searchable.some((c) => c.route === route) ? route : (searchable[0]?.route ?? 'youtube-music');
  const activeCap = caps.find((c) => c.route === active);

  return (
    <section className="src-panel">
      <div className="src-bar">
        <div className="src-field">
          <SearchIcon size={16} />
          <input
            type="search"
            placeholder={`Search ${routeLabel(active)}`}
            aria-label="Search streaming catalog"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        </div>
        {searchable.length > 1 && (
          <nav className="src-pills" aria-label="Streaming routes">
            {searchable.map((c) => (
              <button
                key={c.route}
                className={`src-pill ${active === c.route ? 'on' : ''}`}
                onClick={() => setRoute(c.route)}
              >
                {routeLabel(c.route)}
              </button>
            ))}
          </nav>
        )}
      </div>
      {loading && (
        <div className="src-status" role="status">
          Searching…
        </div>
      )}
      {!loading && error && (
        <div className="src-status src-err" role="alert">
          <span>{error}</span>
          {activeCap?.state === 'unauthenticated' && (
            <button className="chip chip-btn" onClick={() => session.signInRoute(active)}>
              Sign in
            </button>
          )}
        </div>
      )}
      {!loading && !error && results && results.length === 0 && <div className="src-status">No results.</div>}
      {!loading && !error && !results && (
        <div className="src-status">Results play through the {routeLabel(active)} route.</div>
      )}
      {results && results.length > 0 && (
        <div className="src-hits">
          {results.map((t, i) => (
            <div
              key={t.id}
              className="src-hit"
              tabIndex={0}
              onClick={() => session.playTracks(results, i, { kind: 'provider' })}
              onKeyDown={(e) => e.key === 'Enter' && session.playTracks(results, i, { kind: 'provider' })}
            >
              {t.artwork ? (
                <img className="src-hit-art" src={t.artwork.url} alt="" loading="lazy" />
              ) : (
                <span className="src-hit-art src-hit-noart">
                  <NoteIcon size={16} />
                </span>
              )}
              <span className="src-hit-tt">
                <span className="src-hit-title">{t.title}</span>
                <span className="src-hit-artist">{artistsLine(t.artists)}</span>
              </span>
              <RouteBadge provider={providerForRoute(t.route)} title={t.route} />
              <span className="src-hit-time">{formatTime(t.durationMs)}</span>
              <button
                className="icon-btn src-hit-next"
                aria-label={`Play ${t.title} next`}
                title="Play next"
                onClick={(e) => {
                  e.stopPropagation();
                  session.insertNext(t);
                }}
              >
                <PlusIcon size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function SourcesView() {
  const capabilities = useUi((s) => s.capabilities);
  return (
    <div className="src">
      <h2 className="src-h">Streaming</h2>
      <ProviderSearch caps={capabilities} />
      <h2 className="src-h">Sources</h2>
      <div className="src-routes">
        {capabilities.map((c) => (
          <RouteCard key={c.route} cap={c} />
        ))}
      </div>
      {capabilities.length === 0 && (
        <div className="src-empty" role="status">
          No playback routes reported yet.
        </div>
      )}
    </div>
  );
}
