import { useState } from 'react';
import { session } from '../app';
import { artistsLine } from '../format';
import { useUi } from '../hooks';
import {
  NextIcon,
  NoteIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RepeatIcon,
  ShuffleIcon,
} from '../icons';
import { SeekBar } from './SeekBar';
import { QueueToggle, VolumeControl } from './Transport';
import { MuteIcon, VolumeIcon } from '../icons';
import './playerbar.css';


/**
 * Artwork palette[0] → a legible accent. Grey or near-black art would make
 * muddy chrome, so saturation/lightness are clamped into a band where the
 * accent stays vivid and dark glyphs on it keep their contrast. Returns null
 * when the art has no hue worth using, leaving the resting coral.
 */
function HeartIcon({ size = 18, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 20.3c-.5 0-.95-.14-1.34-.4C6.85 17.35 3.6 14.3 3.6 10.55c0-2.75 2.2-4.95 4.95-4.95 1.45 0 2.65.7 3.45 1.8.8-1.1 2-1.8 3.45-1.8 2.75 0 4.95 2.2 4.95 4.95 0 3.75-3.25 6.8-7.06 9.35-.39.26-.84.4-1.34.4Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LyricsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M9.2 6.8 6.3 12v4.4c0 .7.5 1.2 1.2 1.2h3c.7 0 1.2-.5 1.2-1.2v-3.2c0-.7-.5-1.2-1.2-1.2H8.5l1.6-5.2zM17.6 6.8 14.7 12v4.4c0 .7.5 1.2 1.2 1.2h3c.7 0 1.2-.5 1.2-1.2v-3.2c0-.7-.5-1.2-1.2-1.2h-2.1l1.6-5.2z" />
    </svg>
  );
}

/**
 * Floating bottom player bar. No props — App mounts it globally and reads
 * everything from the session store.
 */
export function PlayerBar() {
  const track = useUi((s) => s.snapshot.current?.track);
  const status = useUi((s) => s.snapshot.status);
  const shuffle = useUi((s) => s.queue.shuffle);
  const repeat = useUi((s) => s.queue.repeat);
  const route = useUi((s) => s.snapshot.lease?.route ?? s.snapshot.current?.track.route);
  const cap = useUi((s) => s.capabilities.find((c) => c.route === route));
  const palette = useUi((s) => s.palette);
  const lyricsOn = useUi((s) => s.nowPlayingExpanded);
  const muted = useUi((s) => s.snapshot.muted === true);

    // Love state is a per-track stub until the protocol grows favorites.

  const playing = status === 'playing';
  const busy = status === 'loading' || status === 'buffering';
  const canSkip = cap ? cap.playback.canNextPrevious : true;
  const canPause = cap ? cap.playback.canPause : true;
  const glow = palette[0];

  return (
    <footer className={`playerbar ${track ? '' : 'idle'}`} aria-label="Player">
      {/* pb-center leads DOM order so the transport is the first play-named
          control in the document; grid-area pins keep the visual layout. */}
      <div className="pb-center">
        <div className="pb-tp">
          <button
            className={`icon-btn tp-side ${shuffle ? 'on' : ''}`}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={() => session.toggleShuffle()}
          >
            <ShuffleIcon size={16} />
          </button>
          <button
            className="icon-btn tp-nav"
            aria-label="Previous track"
            disabled={!canSkip}
            onClick={() => session.previous()}
          >
            <PrevIcon size={19} />
          </button>
          <button
            className={`tp-play ${busy ? 'busy' : ''}`}
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={playing && !canPause}
            onClick={() => session.togglePlay()}
          >
            <span className={`tp-ic ${playing ? 'hide' : ''}`}>
              <PlayIcon size={19} />
            </span>
            <span className={`tp-ic ${playing ? '' : 'hide'}`}>
              <PauseIcon size={18} />
            </span>
          </button>
          <button className="icon-btn tp-nav" aria-label="Next track" disabled={!canSkip} onClick={() => session.next()}>
            <NextIcon size={19} />
          </button>
          <button
            className={`icon-btn tp-side ${repeat !== 'off' ? 'on' : ''}`}
            aria-label={`Repeat: ${repeat}`}
            aria-pressed={repeat !== 'off'}
            onClick={() => session.cycleRepeat()}
          >
            <RepeatIcon size={16} />
            {repeat === 'one' && <span className="tp-one">1</span>}
          </button>
        </div>
        <SeekBar />
      </div>

      <div className="pb-left">
        <button
          className="pb-art"
          aria-label="Show now playing"
          onClick={() => { session.setView('now'); session.setNowPlayingExpanded(true); }}
          style={
            track && glow
              ? { boxShadow: `0 6px 20px -6px rgba(${glow[0]},${glow[1]},${glow[2]},0.55)` }
              : undefined
          }
        >
          {track?.artwork ? (
            <img src={track.artwork.url} alt="" draggable={false} />
          ) : (
            <NoteIcon size={22} />
          )}
        </button>
        <div className="pb-meta">
          <span className="pb-title">{track?.title ?? 'Nothing playing'}</span>
          <span className="pb-artist">{track ? artistsLine(track.artists) : 'Pick something from your library'}</span>
        </div>
      </div>

      <div className="pb-right">
        <VolumeControl />
        <button
          className="icon-btn pb-mute"
          aria-label={muted ? 'Unmute' : 'Mute'}
          onClick={() => session.toggleMute()}
        >
          {muted ? <MuteIcon size={18} /> : <VolumeIcon size={18} />}
        </button>
        <QueueToggle />
        <button
          className={`icon-btn pb-lyr ${lyricsOn ? 'on' : ''}`}
          aria-label="Lyrics view"
          aria-pressed={lyricsOn}
          title="Lyrics"
          disabled={!track}
          onClick={() => {
            if (!lyricsOn) session.setView('now');
            session.setNowPlayingExpanded(!lyricsOn);
          }}
        >
          <LyricsIcon size={18} />
        </button>
      </div>
    </footer>
  );
}
