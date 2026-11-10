import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Tri } from '@cadence/protocol';
import { session } from '../session';
import { useUi } from '../hooks';
import { CloseIcon, GearIcon } from '../icons';
import type { AudioDevice } from '../store';

const EQ_FREQS = [60, 150, 400, 1000, 2400, 6000, 12000, 15000];
const EQ_MAX_DB = 12;

function freqLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

function gainLabel(db: number): string {
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}

function EqSection() {
  const storedEq = useUi((s) => s.eqBands);
  const [gains, setGains] = useState<number[]>(() =>
    EQ_FREQS.map((f) => storedEq.find((b) => b.freqHz === f)?.gainDb ?? 0),
  );
  const eqTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaseRoute = useUi((s) => s.snapshot.lease?.route);
  const trackRoute = useUi((s) => s.snapshot.current?.track.route);
  const bypass = useUi((s) => s.snapshot.output?.fidelityBypass ?? false);
  const eqTri: Tri = useUi((s) => {
    const route = s.snapshot.lease?.route ?? s.snapshot.current?.track.route;
    return s.capabilities.find((c) => c.route === route)?.audio.eq ?? 'unknown';
  });
  const route = leaseRoute ?? trackRoute;

  const unavailable = route != null && eqTri !== 'yes';
  const dimmed = unavailable || bypass;
  const note = bypass
    ? 'Bypassed while fidelity mode is on.'
    : eqTri === 'no'
      ? 'The active route cannot apply EQ.'
      : 'The active route has not confirmed EQ support.';

  const apply = (next: number[]) => {
    setGains(next);
    // Slider ticks fire per-move; the engine rebuilds the pipeline per
    // setEq, so coalesce drags into one send.
    if (eqTimer.current !== null) clearTimeout(eqTimer.current);
    eqTimer.current = setTimeout(() => {
      session.setEq(next.map((gainDb, i) => ({ freqHz: EQ_FREQS[i]!, gainDb })));
    }, 150);
  };

  return (
    <section className={`set-sec ${dimmed ? 'set-dim' : ''}`} aria-label="Engine EQ">
      <div className="set-row">
        <div className="set-txt">
          <span className="set-label">Engine EQ</span>
          <span className="set-sub">{dimmed ? note : 'Parametric bands in the Cadence audio graph.'}</span>
        </div>
        <button
          className="chip chip-btn"
          disabled={dimmed}
          onClick={() => {
            setGains(EQ_FREQS.map(() => 0));
            session.setEq([]);
          }}
        >
          Flat
        </button>
      </div>
      <div className="eq-grid">
        {EQ_FREQS.map((hz, i) => (
          <div className="eq-band" key={hz}>
            <span className="eq-gain" aria-hidden="true">
              {gainLabel(gains[i]!)}
            </span>
            <input
              type="range"
              className="eq-slider"
              aria-label={`EQ ${freqLabel(hz)} Hz`}
              min={-EQ_MAX_DB}
              max={EQ_MAX_DB}
              step={0.5}
              value={gains[i]}
              disabled={dimmed}
              style={{ '--lo': `${Math.min(50, ((gains[i]! + EQ_MAX_DB) / (EQ_MAX_DB * 2)) * 100)}%`, '--hi': `${Math.max(50, ((gains[i]! + EQ_MAX_DB) / (EQ_MAX_DB * 2)) * 100)}%` } as React.CSSProperties}
              onChange={(e) => apply(gains.map((g, j) => (j === i ? Number(e.currentTarget.value) : g)))}
            />
            <span className="eq-freq">{freqLabel(hz)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function FidelitySection() {
  // The switch reflects the user's setting; the sub-line reports what the
  // engine actually negotiated — two honest, different things.
  const enabled = useUi((s) => s.snapshot.fidelityMode ?? false);
  const bypassed = useUi((s) => s.snapshot.output?.fidelityBypass ?? false);
  const sub = enabled
    ? bypassed
      ? 'At source rate with EQ and ReplayGain bypassed. System resampling may still apply.'
      : 'On: app processing bypass is unavailable for this output format.'
    : 'Bypasses Cadence’s EQ, ReplayGain and resampling where supported.';
  return (
    <section className="set-sec" aria-label="Fidelity mode">
      <div className="set-row">
        <div className="set-txt">
          <span className="set-label">Fidelity mode</span>
          <span className="set-sub">{sub}</span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="Fidelity mode"
          checked={enabled}
          onChange={(e) => session.setFidelityMode(e.currentTarget.checked)}
        />
      </div>
    </section>
  );
}

function ReplayGainSection() {
  const enabled = useUi((s) => s.snapshot.replayGain ?? false);
  return (
    <section className="set-sec" aria-label="ReplayGain">
      <div className="set-row">
        <div className="set-txt">
          <span className="set-label">ReplayGain</span>
          <span className="set-sub">
            {enabled
              ? 'On — applying per-track gain from file tags.'
              : 'Off — tagged ReplayGain values are ignored.'}
          </span>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="ReplayGain"
          checked={enabled}
          onChange={(e) => session.setReplayGain(e.currentTarget.checked)}
        />
      </div>
    </section>
  );
}

function DeviceSection() {
  const current = useUi((s) => s.snapshot.output?.deviceName);
  const [devices, setDevices] = useState<AudioDevice[]>([]);

  useEffect(() => {
    let live = true;
    void session.listDevices().then((d) => {
      if (live) setDevices(d);
    });
    return () => {
      live = false;
    };
  }, []);

  const known = devices.some((d) => d.name === current);
  return (
    <section className="set-sec" aria-label="Output device">
      <div className="set-row">
        <div className="set-txt">
          <span className="set-label">Output device</span>
          <span className="set-sub">{current ?? 'No output reported yet.'}</span>
        </div>
      </div>
      <select
        className="dev-select"
        aria-label="Output device"
        value={current ?? ''}
        onChange={(e) => session.setDevice(e.currentTarget.value || null)}
      >
        <option value="">System default</option>
        {current && !known && (
          <option value={current}>{current}</option>
        )}
        {devices.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}
            {d.isDefault && !/default/i.test(d.name) ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </section>
  );
}

export function SettingsSheet() {
  const [open, setOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
        return;
      }
      if (e.key !== 'Tab' || !sheetRef.current) return;
      const focusables = sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables.length) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === sheetRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || active === sheetRef.current)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    (sheetRef.current?.querySelector('button, input, select') as HTMLElement | null)?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <div className="settings">
      <button
        ref={btnRef}
        className={`chrome-btn ${open ? 'is-on' : ''}`}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <GearIcon size={19} />
      </button>
      {open &&
        createPortal(
          <>
            <div className="sheet-backdrop" onClick={() => setOpen(false)} />
            <div className="sheet" role="dialog" aria-label="Settings" ref={sheetRef} tabIndex={-1}>
              <div className="sheet-head">
                <h2>Settings</h2>
                <button className="icon-btn" aria-label="Close settings" onClick={() => setOpen(false)}>
                  <CloseIcon size={15} />
                </button>
              </div>
              <FidelitySection />
              <ReplayGainSection />
              <EqSection />
              <DeviceSection />
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
