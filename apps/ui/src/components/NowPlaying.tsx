import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { session } from '../app';
import { artistsLine } from '../format';
import { useReducedMotion, useUi } from '../hooks';
import { NoteIcon } from '../icons';
import { PixiBackground } from '../visuals/PixiBackground';
import { CapabilityChips } from './CapabilityChips';
import { providerForRoute, RouteBadge } from './RouteBadge';
import { NowPlayingFull } from './NowPlayingFull';

function Artwork() {
  const track = useUi((s) => s.snapshot.current?.track);
  const status = useUi((s) => s.snapshot.status);
  const palette = useUi((s) => s.palette);


  if (!track) return null;
  const glow = palette[0];
  return (
    <div
      className={`np-art ${status === 'playing' ? 'live' : ''}`}
      style={glow ? { boxShadow: `0 24px 90px -18px rgba(${glow[0]},${glow[1]},${glow[2]},0.45), 0 12px 40px rgba(0,0,0,0.55)` } : undefined}
    >
      {track.artwork ? (
        <img key={track.id} src={track.artwork.url} alt={`${track.album ?? track.title} artwork`} draggable={false} />
      ) : (
        <div className="np-art-empty">
          <NoteIcon size={64} />
        </div>
      )}
    </div>
  );
}

export function NowPlaying() {
  // Narrow selectors: position/fft updates at 2-20Hz must not re-render this
  // tree — the seek bar and Pixi layer read those off-store.
  const expanded = useUi((s) => s.nowPlayingExpanded);
  const closeFull = useCallback(() => session.setNowPlayingExpanded(false), []);
  const status = useUi((s) => s.snapshot.status);
  const lastError = useUi((s) => s.snapshot.lastError);
  const palette = useUi((s) => s.palette);
  const track = useUi((s) => s.snapshot.current?.track);

  return (
    <div className="np">
      {!expanded && <PixiBackground palette={palette} />}
      {track && <button className="np-expand" onClick={() => session.setNowPlayingExpanded(true)} aria-label="Expand now playing"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 4h5v5M20 4 12.5 11.5M9 20H4v-5M4 20l7.5-7.5" /></svg> <span>Full screen</span></button>}
      {expanded && track && createPortal(<NowPlayingFull onClose={closeFull} />, document.body)}
      {track ? (
        <div className="np-inner">
          <Artwork />
          <div className="np-meta">
            <RouteBadge provider={providerForRoute(track.route)} title={`Route: ${track.route}`} />
            <h1 className="np-title" title={track.title}>
              {track.title}
            </h1>
            <div className="np-sub">
              <span className="np-artist">{artistsLine(track.artists)}</span>
              {track.album && (
                <>
                  <span className="np-dot">·</span>
                  <span className="np-album" title={track.album}>
                    {track.album}
                  </span>
                </>
              )}
              {track.year && (
                <>
                  <span className="np-dot">·</span>
                  <span>{track.year}</span>
                </>
              )}
            </div>
            {status === 'error' && lastError && (
              <div className="np-error" role="alert">
                {lastError.message}
              </div>
            )}
            <CapabilityChips />
          </div>
        </div>
      ) : (
        <div className="np-empty">
          <NoteIcon size={72} />
          <h1>Nothing playing</h1>
          <p>Pick an album or a track from your library.</p>
          <button className="btn" onClick={() => session.setView('library')}>
            Open Library
          </button>
        </div>
      )}
    </div>
  );
}
