import { session } from '../session';
import { useUi } from '../hooks';
import { activeCapabilities } from '../routes';
import { MuteIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, RepeatIcon, ShuffleIcon, VolumeIcon } from '../icons';
import './controls.css';

/** Mute button plus a slim volume slider with a round thumb. */
export function VolumeControl() {
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
        {muted || shown === 0 ? <MuteIcon size={18} /> : <VolumeIcon size={18} />}
      </button>
      <input
        type="range"
        className="vol-input"
        aria-label="Volume"
        min={0}
        max={100}
        value={Math.round(shown * 100)}
        onChange={(e) => session.setVolume(Number(e.currentTarget.value) / 100)}
        style={{ '--p': shown }}
      />
    </div>
  );
}

/**
 * Shuffle · previous · play/pause · next · repeat. Quiet glyph buttons
 * around one solid white play circle.
 */
export function Transport() {
  const status = useUi((s) => s.snapshot.status);
  const repeat = useUi((s) => s.queue.repeat);
  const shuffle = useUi((s) => s.queue.shuffle);
  const hasTrack = useUi((s) => s.snapshot.current !== null || s.queue.items.length > 0);
  const cap = useUi(activeCapabilities);
  const playing = status === 'playing';
  const busy = status === 'loading' || status === 'buffering';
  const canSkip = cap?.playback.canNextPrevious ?? true;
  const canPause = cap?.playback.canPause ?? true;

  return (
    <div className="transport">
      <button
        className={`ctl-btn ctl-side ${shuffle ? 'is-on' : ''}`}
        aria-label="Shuffle"
        aria-pressed={shuffle}
        title="Shuffle"
        onClick={() => session.toggleShuffle()}
      >
        <ShuffleIcon size={17} />
      </button>
      <button className="ctl-btn" aria-label="Previous track" title="Previous" disabled={!canSkip || !hasTrack} onClick={() => session.previous()}>
        <PrevIcon size={18} />
      </button>
      <button
        className={`ctl-btn ctl-play ${busy ? 'is-busy' : ''}`}
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={(playing && !canPause) || !hasTrack}
        onClick={() => session.togglePlay()}
      >
        <span className={`icon-swap ${playing ? '' : 'is-play'}`}>
          {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </span>
      </button>
      <button className="ctl-btn" aria-label="Next track" title="Next" disabled={!canSkip || !hasTrack} onClick={() => session.next()}>
        <NextIcon size={18} />
      </button>
      <button
        className={`ctl-btn ctl-side ${repeat !== 'off' ? 'is-on' : ''}`}
        aria-label={`Repeat: ${repeat}`}
        aria-pressed={repeat !== 'off'}
        title={`Repeat: ${repeat}`}
        onClick={() => session.cycleRepeat()}
      >
        <RepeatIcon size={17} />
        {repeat === 'one' && <span className="ctl-one">1</span>}
      </button>
    </div>
  );
}
