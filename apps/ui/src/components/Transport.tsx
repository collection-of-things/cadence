import { session } from '../app';
import { useUi } from '../hooks';
import { MuteIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, QueueIcon, RepeatIcon, ShuffleIcon, VolumeIcon } from '../icons';
import './controls.css';


export function VolumeControl() {
  const volume = useUi((s) => s.snapshot.volume);
  const muted = useUi((s) => s.snapshot.muted);
  const shown = muted ? 0 : volume;
  return (
    <div className="vol">
      <button
        className="icon-btn"
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
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
        style={{ ['--p' as string]: shown }}
      />
    </div>
  );
}

export function QueueToggle() {
  const open = useUi((s) => s.queueOpen);
  const count = useUi((s) => s.queue.items.length);
  return (
    <button
      className={`icon-btn q-toggle ${open ? 'on' : ''}`}
      aria-label="Toggle queue"
      aria-pressed={open}
      onClick={() => session.setQueueOpen(!open)}
    >
      <QueueIcon size={19} />
      {count > 0 && <span className="q-count">{count > 99 ? "99+" : count}</span>}
    </button>
  );
}

export function Transport() {
  const status = useUi((s) => s.snapshot.status);
  const repeat = useUi((s) => s.queue.repeat);
  const shuffle = useUi((s) => s.queue.shuffle);
  // Reactive selectors — capability changes update the controls immediately.
  const route = useUi((s) => s.snapshot.lease?.route ?? s.snapshot.current?.track.route);
  const capabilities = useUi((s) => s.capabilities);
  const cap = capabilities.find((c) => c.route === route);
  const playing = status === 'playing';
  const busy = status === 'loading' || status === 'buffering';
  const canSkip = cap ? cap.playback.canNextPrevious : true;
  const canPause = cap ? cap.playback.canPause : true;

  return (
    <div className="transport">
      <div className="tp-cluster">
        <button
          className={`icon-btn tp-side ${shuffle ? 'on' : ''}`}
          aria-label="Shuffle"
          aria-pressed={shuffle}
          onClick={() => session.toggleShuffle()}
        >
          <ShuffleIcon size={18} />
        </button>
        <button className="icon-btn tp-nav" aria-label="Previous track" disabled={!canSkip} onClick={() => session.previous()}>
          <PrevIcon size={22} />
        </button>
        <button
          className={`tp-play ${busy ? 'busy' : ''}`}
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={playing && !canPause}
          onClick={() => session.togglePlay()}
        >
          <span className={`tp-ic ${playing ? 'hide' : ''}`}>
            <PlayIcon size={26} />
          </span>
          <span className={`tp-ic ${playing ? '' : 'hide'}`}>
            <PauseIcon size={26} />
          </span>
        </button>
        <button className="icon-btn tp-nav" aria-label="Next track" disabled={!canSkip} onClick={() => session.next()}>
          <NextIcon size={22} />
        </button>
        <button
          className={`icon-btn tp-side ${repeat !== 'off' ? 'on' : ''}`}
          aria-label={`Repeat: ${repeat}`}
          aria-pressed={repeat !== 'off'}
          onClick={() => session.cycleRepeat()}
        >
          <RepeatIcon size={18} />
          {repeat === 'one' && <span className="tp-one">1</span>}
        </button>
      </div>
      <div className="tp-right">
        <VolumeControl />
        <QueueToggle />
      </div>
    </div>
  );
}
