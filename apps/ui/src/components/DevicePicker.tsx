import { useEffect, useRef, useState } from 'react';
import type { RemotePairedDevice } from '@cadence/protocol';
import { useUi } from '../hooks';
import { ComputerIcon, DevicesIcon, PhoneIcon } from '../icons';
import { useEscapeLayer } from '../layers';
import { session } from '../session';

function deviceLine(d: RemotePairedDevice, playing: boolean): string {
  if (playing) return 'Playing now';
  return d.online ? 'Connected' : 'Not connected';
}

/**
 * "Play on" picker in the player bar: this computer or a paired phone.
 * Choosing a phone asks it to take over; choosing the computer brings
 * playback back at the phone's position.
 */
export function DevicePicker({ onOpenSettings }: { onOpenSettings(): void }) {
  const remote = useUi((s) => s.remote);
  const hasTrack = useUi((s) => s.snapshot.current !== null);
  const playingHere = useUi((s) => s.localSnapshot.status === 'playing');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    ref.current?.querySelector<HTMLElement>('[role="menuitemradio"]:not(:disabled), [role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = () => {
    setOpen(false);
    ref.current?.querySelector<HTMLElement>('.dev-trigger')?.focus();
  };
  useEscapeLayer('menu', open, close);

  // No phone-sync bridge (older shell): nothing to pick from.
  if (remote === null) return null;
  const active = remote.activeOutput;
  const on = remote.server.kind === 'on';
  const label = active ? `Playing on ${active.deviceName}` : 'Play on';

  return (
    <div className="dev-picker" ref={ref}>
      <button
        className={`ctl-btn dev-trigger ${active ? 'is-on is-remote' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <DevicesIcon size={18} />
      </button>
      {open && (
        <div className="menu menu-up dev-menu" role="menu" aria-label="Play on">
          <div className="dev-head" aria-hidden="true">Play on</div>
          <button
            role="menuitemradio"
            aria-checked={active === null}
            className={`dev-item ${active === null ? 'is-current' : ''}`}
            onClick={() => {
              if (active !== null) session.playHere();
              close();
            }}
          >
            <ComputerIcon size={18} />
            <span className="dev-txt">
              <span className="dev-name">This computer</span>
              <span className="dev-sub">{active !== null ? 'Bring playback back here' : playingHere ? 'Playing here' : hasTrack ? 'Paused' : 'Ready'}</span>
            </span>
          </button>
          {on &&
            remote.devices.map((d) => {
              const isActive = active?.deviceId === d.id;
              return (
                <button
                  key={d.id}
                  role="menuitemradio"
                  aria-checked={isActive}
                  disabled={!isActive && (!d.online || !hasTrack)}
                  className={`dev-item ${isActive ? 'is-current' : ''}`}
                  title={!d.online ? 'Open Cadence on the phone to connect it.' : undefined}
                  onClick={() => {
                    if (!isActive) session.playOnDevice(d.id);
                    close();
                  }}
                >
                  <PhoneIcon size={18} />
                  <span className="dev-txt">
                    <span className="dev-name">{d.name}</span>
                    <span className="dev-sub">{deviceLine(d, isActive)}</span>
                  </span>
                  {d.online && !isActive && <span className="dev-dot" aria-hidden="true" />}
                </button>
              );
            })}
          <div className="dev-sep" role="separator" />
          <button
            role="menuitem"
            className="dev-link"
            onClick={() => {
              close();
              onOpenSettings();
            }}
          >
            {!on ? 'Set up phone sync' : remote.devices.length === 0 ? 'Pair a phone' : 'Phone settings'}
          </button>
        </div>
      )}
    </div>
  );
}
