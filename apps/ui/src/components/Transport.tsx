import { session } from '../session';
import { useUi } from '../hooks';
import { MuteIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, RepeatIcon, ShuffleIcon, VolumeIcon } from '../icons';
import './controls.css';

/** Mute button plus a slim volume slider with a round thumb. */
export function VolumeControl({ slider = true }: { slider?: boolean }) {
  const volume = useUi((s) => s.snapshot.volume);
  const muted = useUi((s) => s.snapshot.muted);
  const shown = muted ? 0 : volume;
  return (
    <div className="vol">
      <button
        className="ctl-btn"
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
        title={muted ? 'Unmute (M)' : 'Mute (M)'}
        onClick={() => session.toggleMute()}
      >
        {muted || shown === 0 ? <MuteIcon size={19} /> : <VolumeIcon size={19} />}
      </button>
      {slider && (
        <input
          type="range"
          className="vol-input"
          aria-label="Volume"
          min={0}
          max={100}
          value={Math.round(shown * 100)}
          onChange={(e) => session.setVolume(Number(e.currentTarget.value) / 100)}
          style={{ ['--p' as string]: shown }}
        />
      )}
    </div>
  );
}

/**
 * Shuffle · previous · play/pause · next · repeat. Glyph-only buttons, no
 * filled play circle — the reference keeps every control at one weight.
 */
export function Transport({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const status = useUi((s) => s.snapshot.status);
  const repeat = useUi((s) => s.queue.repeat);
  const shuffle = useUi((s) => s.queue.shuffle);
  const hasTrack = useUi((s) => s.snapshot.current !== null || s.queue.items.length > 0);
  const cap = useUi((s) => {
    const route = s.snapshot.lease?.route ?? s.snapshot.current?.track.route;
    return s.capabilities.find((c) => c.route === route);
  });
  const playing = status === 'playing';
  const busy = status === 'loading' || status === 'buffering';
  const canSkip = cap ? cap.playback.canNextPrevious : true;
  const canPause = cap ? cap.playback.canPause : true;
  const big = size === 'lg';

  return (
    <div className={`transport transport-${size}`}>
      <button
        className={`ctl-btn ctl-side ${shuffle ? 'is-on' : ''}`}
        aria-label="Shuffle"
        aria-pressed={shuffle}
        title="Shuffle"
        onClick={() => session.toggleShuffle()}
      >
        <ShuffleIcon size={big ? 19 : 18} />
      </button>
      <button className="ctl-btn" aria-label="Previous track" title="Previous" disabled={!canSkip || !hasTrack} onClick={() => session.previous()}>
        <PrevIcon size={big ? 24 : 22} />
      </button>
      <button
        className={`ctl-btn ctl-play ${busy ? 'is-busy' : ''}`}
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={(playing && !canPause) || !hasTrack}
        onClick={() => session.togglePlay()}
      >
        <span className="icon-swap" key={playing ? 'pause' : 'play'}>
          {playing ? <PauseIcon size={big ? 26 : 24} /> : <PlayIcon size={big ? 26 : 24} />}
        </span>
      </button>
      <button className="ctl-btn" aria-label="Next track" title="Next" disabled={!canSkip || !hasTrack} onClick={() => session.next()}>
        <NextIcon size={big ? 24 : 22} />
      </button>
      <button
        className={`ctl-btn ctl-side ${repeat !== 'off' ? 'is-on' : ''}`}
        aria-label={`Repeat: ${repeat}`}
        aria-pressed={repeat !== 'off'}
        title={`Repeat: ${repeat}`}
        onClick={() => session.cycleRepeat()}
      >
        <RepeatIcon size={big ? 19 : 18} />
        {repeat === 'one' && <span className="ctl-one">1</span>}
      </button>
    </div>
  );
}
