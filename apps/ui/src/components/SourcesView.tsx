import { useEffect, useRef, useState } from 'react';
import type { RouteCapabilities, RouteId, TrackRef } from '@cadence/protocol';
import { api, session } from '../session';
import { artistsLine, formatTime } from '../format';
import { useUi } from '../hooks';
import { NoteIcon, SearchIcon } from '../icons';
import { AddGlyph, useJustAdded } from './AddGlyph';
import { cleanIpcError } from '../ipcError';
import { ROUTE_STATE_META, routeLabel } from '../routes';
import { RouteBadge } from './RouteBadge';
import './controls.css';

const ENGINE_LABELS: Record<RouteCapabilities['playback']['engine'], string> = {
  'native-pcm': 'Native PCM',
  'provider-engine': 'Provider engine',
  none: 'No engine',
};

/** "up to 32-bit…" reads as a sentence: capital first letter. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function RouteCard({ cap }: { cap: RouteCapabilities }) {
  const meta = ROUTE_STATE_META[cap.state];
  // What the route is confirmed to do leads as chips; what it might do is
  // one quiet line; the engine and its notes wait behind Details.
  const tri = [
    { key: 'gap', tri: cap.playback.gapless, label: 'Gapless' },
    { key: 'eq', tri: cap.audio.eq, label: 'EQ' },
    { key: 'pcm', tri: cap.audio.pcmAccess, label: 'PCM' },
    { key: 'rg', tri: cap.audio.replayGain, label: 'ReplayGain' },
  ];
  const confirmed = tri.filter((c) => c.tri === 'yes');
  const unconfirmed = tri.filter((c) => c.tri === 'unknown').map((c) => c.label);
  const visuals = cap.visuals.kind === 'pcm-fft' ? 'Spectrum visuals from the audio' : 'Ambient visuals';

  return (
    <section className="src-route">
      <header className="src-route-head">
        <span className="src-route-name">{routeLabel(cap.route)}</span>
        <span className={`src-state is-${meta.tone}`} title={cap.stateDetail}>
          <i className="src-dot" aria-hidden />
          {meta.label}
        </span>
      </header>
      {cap.audio.qualityCeiling && <p className="src-quality">{sentence(cap.audio.qualityCeiling)}</p>}
      {cap.stateDetail && <p className="src-route-detail">{cap.stateDetail}</p>}
      {confirmed.length > 0 && (
        <ul className="cap-chips" aria-label="Capabilities">
          {confirmed.map((c) => <li key={c.key} className="cap-chip is-ok">{c.label}</li>)}
        </ul>
      )}
      {unconfirmed.length > 0 && <p className="src-unconfirmed">Not confirmed: {unconfirmed.join(', ')}</p>}
      <details className="src-details">
        <summary>Details</summary>
        <ul className="src-notes">
          <li>{ENGINE_LABELS[cap.playback.engine]} · {visuals}</li>
          {cap.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </details>
      {cap.state === 'unauthenticated' && (
        <button className="btn btn-primary src-signin" onClick={() => session.signInRoute(cap.route)}>
          Sign in
        </button>
      )}
      {cap.state === 'ready' && cap.canSignOut === true && (
        <button className="btn src-signout" onClick={() => session.signOutRoute(cap.route)}>
          Sign out
        </button>
      )}
    </section>
  );
}

/** "Play next" on a search hit; the plus turns into a check once queued. */
function PlayNextButton({ track }: { track: TrackRef }) {
  const { added, flash } = useJustAdded();
  return (
    <button
      className="icon-btn src-hit-next"
      aria-label={`Play ${track.title} next`}
      title={added ? 'Plays next' : 'Play next'}
      onClick={(e) => {
        e.stopPropagation();
        session.insertNext(track);
        flash();
      }}
    >
      <AddGlyph added={added} size={15} />
    </button>
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
              onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && session.playTracks(results, i, { kind: 'provider' })}
            >
              {t.artwork ? (
                <img className="src-hit-art" src={t.artwork.url} alt="" width={38} height={38} loading="lazy" decoding="async" />
              ) : (
                <span className="src-hit-art src-hit-noart">
                  <NoteIcon size={16} />
                </span>
              )}
              <span className="src-hit-tt">
                <span className="src-hit-title">{t.title}</span>
                <span className="src-hit-artist">{artistsLine(t.artists)}</span>
              </span>
              <RouteBadge route={t.route} />
              <span className="src-hit-time">{formatTime(t.durationMs)}</span>
              <PlayNextButton track={t} />
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
      <header className="src-head"><h1>Sources</h1></header>
      <ProviderSearch caps={capabilities} />
      <h2 className="src-h">Services</h2>
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
