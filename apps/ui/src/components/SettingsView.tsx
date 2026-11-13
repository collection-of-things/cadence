import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LibraryCounts, RemotePairedDevice, RemoteStatus, RouteId } from '@cadence/protocol';
import { useUi } from '../hooks';
import { cleanIpcError } from '../ipcError';
import type { SettingsSection } from '../navigation';
import { ACCENTS, SKIP_SECONDS, setPrefs, usePrefs } from '../prefs';
import { ROUTE_STATE_META, activeCapabilities, activeRoute, routeForPlatform, routeLabel } from '../routes';
import { api, session } from '../session';
import type { AudioDevice } from '../store';

const EQ_FREQS = [60, 150, 400, 1000, 2400, 6000, 12000, 15000];
const EQ_MAX_DB = 12;

function freqLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

function gainLabel(db: number): string {
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}

/** The slider's filled span: from the centre line to the thumb. */
function eqFill(db: number): CSSProperties {
  const at = ((db + EQ_MAX_DB) / (EQ_MAX_DB * 2)) * 100;
  return { '--lo': `${Math.min(50, at)}%`, '--hi': `${Math.max(50, at)}%` };
}

function EqSection() {
  const storedEq = useUi((s) => s.eqBands);
  const [gains, setGains] = useState<number[]>(() =>
    EQ_FREQS.map((f) => storedEq.find((b) => b.freqHz === f)?.gainDb ?? 0),
  );
  const eqTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const route = useUi(activeRoute);
  const bypass = useUi((s) => s.snapshot.output?.fidelityBypass ?? false);
  const eqTri = useUi((s) => activeCapabilities(s)?.audio.eq ?? 'unknown');

  const unavailable = route !== undefined && eqTri !== 'yes';
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
              style={eqFill(gains[i]!)}
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
      ? 'Active: bypassing EQ and resampling at the source rate.'
      : 'On. Bypass applies when the device accepts the source format.'
    : 'Bypasses EQ and resampling when the device accepts the source format.';
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
              ? 'On. Applying per-track gain from file tags.'
              : 'Off. Tagged ReplayGain values are ignored.'}
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

/**
 * The streaming route in use (the one playing, else the active service's)
 * when it plays through its own player. Null for Cadence's own engine.
 */
function useProviderEngineRoute(): RouteId | null {
  return useUi((s) => {
    const route = activeRoute(s) ?? routeForPlatform(s.platform);
    if (!route || route === 'local') return null;
    const engine = s.capabilities.find((c) => c.route === route)?.playback.engine;
    return engine === 'native-pcm' ? null : route;
  });
}

/** One titled group of settings, drawn as a card. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-group" aria-label={title}>
      <h2 className="set-group-title">{title}</h2>
      <div className="set-card">{children}</div>
    </section>
  );
}

/** A labelled row with its control on the right. */
function Row({ label, sub, children }: { label: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-sec">
      <div className="set-row">
        <div className="set-txt">
          <span className="set-label">{label}</span>
          {sub && <span className="set-sub">{sub}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Sign-in state and sign in / sign out for each streaming service that can run here. */
function AccountsSection() {
  const services = useUi(useShallow((s) => s.capabilities.filter((c) => c.route !== 'local' && c.state !== 'unavailable')));
  return (
    <Group title="Accounts">
      {services.length === 0 && <Row label="No streaming services" sub="None are available on this computer yet." />}
      {services.map((cap) => {
        const meta = ROUTE_STATE_META[cap.state];
        return (
          <Row
            key={cap.route}
            label={routeLabel(cap.route)}
            sub={
              <>
                <span className={`src-state is-${meta.tone}`}>
                  <i className="src-dot" aria-hidden />
                  {meta.label}
                </span>
                {cap.stateDetail}
              </>
            }
          >
            {cap.state === 'unauthenticated' && (
              <button className="btn" onClick={() => session.signInRoute(cap.route)}>
                Sign in
              </button>
            )}
            {cap.state === 'ready' && cap.canSignOut === true && (
              <button className="btn" onClick={() => session.signOutRoute(cap.route)}>
                Sign out
              </button>
            )}
          </Row>
        );
      })}
    </Group>
  );
}

/** The folders the local library is built from, with add, remove and rescan. */
function LibrarySection() {
  const scan = useUi((s) => s.scan);
  const [roots, setRoots] = useState<string[] | null>(null);
  const [counts, setCounts] = useState<LibraryCounts | null>(null);
  const scanning = scan.phase === 'scanning';

  const reload = useCallback(() => {
    api.library.roots().then(setRoots).catch(() => setRoots([]));
    api.library.counts().then(setCounts).catch(() => undefined);
  }, []);
  // Reloads when a scan ends, so the totals match what was just indexed.
  useEffect(reload, [reload, scanning]);

  const report = (e: unknown) => session.showToast('local', cleanIpcError(e, 'Library change failed'), false);
  const progress = scanning ? `Scanning ${scan.scanned}${scan.total ? ` of ${scan.total}` : ''}` : null;
  const totals = counts ? `${counts.tracks} ${counts.tracks === 1 ? 'song' : 'songs'} in ${counts.albums} ${counts.albums === 1 ? 'album' : 'albums'}` : null;

  return (
    <Group title="Library">
      <Row label="Music folders" sub={<span role="status">{progress ?? totals}</span>}>
        <button className="btn btn-ghost" disabled={scanning || !roots?.length} onClick={() => void api.library.scan(roots ?? []).catch(report)}>
          Rescan
        </button>
        <button className="btn" onClick={() => void api.library.addFoldersAndScan().then(reload).catch(report)}>
          Add folder
        </button>
      </Row>
      {roots === null && (
        <div className="set-sec">
          <div className="set-skeleton" aria-hidden="true" />
        </div>
      )}
      {roots?.length === 0 && <Row label="No folders yet" sub="Add a folder and Cadence indexes the music inside it." />}
      {roots?.map((root) => (
        <div className="set-sec" key={root}>
          <div className="set-row">
            <span className="set-path" title={root}>{root}</span>
            <button className="btn btn-ghost" aria-label={`Remove ${root}`} onClick={() => void api.library.removeRoots([root]).then(reload).catch(report)}>
              Remove
            </button>
          </div>
        </div>
      ))}
    </Group>
  );
}

/** The engine's audio controls. A streaming service's own player bypasses them, and the note says so. */
function AudioSection() {
  const providerRoute = useProviderEngineRoute();
  return (
    <Group title="Audio engine">
      {providerRoute && <Row label={routeLabel(providerRoute)} sub="Plays through its own player. These settings apply to local files." />}
      <FidelitySection />
      <ReplayGainSection />
      <EqSection />
      <DeviceSection />
    </Group>
  );
}

function PlaybackSection() {
  const skipSeconds = usePrefs((p) => p.skipSeconds);
  const lyricsInNowPlaying = usePrefs((p) => p.lyricsInNowPlaying);
  return (
    <Group title="Player">
      <Row label="Arrow key skip" sub="How far the left and right arrow keys jump. Hold Shift for 30 seconds.">
        <div className="set-seg" role="radiogroup" aria-label="Arrow key skip">
          {SKIP_SECONDS.map((seconds) => (
            <button key={seconds} role="radio" aria-checked={skipSeconds === seconds} className={skipSeconds === seconds ? 'is-on' : ''} onClick={() => setPrefs({ skipSeconds: seconds })}>
              {seconds}s
            </button>
          ))}
        </div>
      </Row>
      <Row label="Lyrics in Now Playing" sub="Open Now Playing with lyrics beside the artwork.">
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="Lyrics in Now Playing"
          checked={lyricsInNowPlaying}
          onChange={(e) => setPrefs({ lyricsInNowPlaying: e.currentTarget.checked })}
        />
      </Row>
    </Group>
  );
}

function AppearanceSection() {
  const accent = usePrefs((p) => p.accent);
  const movingBackground = usePrefs((p) => p.movingBackground);
  return (
    <Group title="Appearance">
      <Row label="Accent colour" sub="Used for buttons, progress and the song that is on.">
        <div className="set-swatches" role="radiogroup" aria-label="Accent colour">
          <button role="radio" aria-checked={accent === 'artwork'} className={`set-swatch-auto ${accent === 'artwork' ? 'is-on' : ''}`} onClick={() => setPrefs({ accent: 'artwork' })}>
            From artwork
          </button>
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={accent === a.id}
              aria-label={a.label}
              title={a.label}
              className={`set-swatch ${accent === a.id ? 'is-on' : ''}`}
              style={{ background: `rgb(${a.rgb.join(' ')})` }}
              onClick={() => setPrefs({ accent: a.id })}
            />
          ))}
        </div>
      </Row>
      <Row label="Moving background" sub="The colour field behind the app drifts while music is on.">
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="Moving background"
          checked={movingBackground}
          onChange={(e) => setPrefs({ movingBackground: e.currentTarget.checked })}
        />
      </Row>
    </Group>
  );
}

function lastSeen(d: RemotePairedDevice, now: number): string {
  if (d.online) return 'Connected now';
  if (d.lastSeenAtMs === null) return 'Not connected yet';
  const mins = Math.round((now - d.lastSeenAtMs) / 60_000);
  if (mins < 1) return 'Last seen just now';
  if (mins < 60) return `Last seen ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `Last seen ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function serverLine(s: RemoteStatus): string {
  switch (s.server.kind) {
    case 'off':
      return 'Phones on the same Wi-Fi can follow playback and stream your local files.';
    case 'starting':
      return 'Starting…';
    case 'on':
      return s.server.addresses.length > 0
        ? `Listening at ${s.server.addresses[0]}:${s.server.port}`
        : `Listening on port ${s.server.port}, but this computer has no network address right now.`;
    case 'error':
      return `Could not start: ${s.server.message}`;
    default: {
      const _exhaustive: never = s.server;
      return _exhaustive;
    }
  }
}

/** A countdown that re-renders each second while the pairing code is live. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Phone sync: the LAN server, pairing, and the phones that can connect. */
function PhoneSection() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.remote.status().then((s) => live && setStatus(s)).catch(() => undefined);
    const off = api.remote.onStatus((s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  const pairing = status?.pairing ?? null;
  const hasTrack = useUi((s) => s.localSnapshot.current !== null || s.remote?.activeOutput != null);
  const now = useNow(pairing !== null);

  const run = (task: () => Promise<RemoteStatus>, failure: string) => {
    setBusy(true);
    task()
      .then(setStatus)
      .catch((e: unknown) => session.showToast('local', cleanIpcError(e, failure), false))
      .finally(() => setBusy(false));
  };

  if (status === null) {
    return (
      <Group title="Phone">
        <div className="set-sec">
          <div className="set-skeleton" aria-hidden="true" />
        </div>
      </Group>
    );
  }

  const on = status.server.kind === 'on';
  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAtMs - now) / 1000)) : 0;

  return (
    <>
      <Group title="Phone">
        <Row label="Phone sync" sub={<span role="status">{serverLine(status)}</span>}>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            aria-label="Phone sync"
            disabled={busy}
            checked={status.enabled}
            onChange={(e) => {
              const enabled = e.currentTarget.checked;
              run(() => api.remote.setEnabled(enabled), 'Could not change phone sync');
            }}
          />
        </Row>
        {on && (
          <Row
            label="Pair a phone"
            sub={pairing ? 'Scan the code with the Cadence phone app, or type the six digits.' : 'Open the Cadence app on your phone and choose Pair.'}
          >
            {pairing ? (
              <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.remote.cancelPairing(), 'Could not cancel pairing')}>
                Cancel
              </button>
            ) : (
              <button className="btn" disabled={busy} onClick={() => run(() => api.remote.startPairing(), 'Could not start pairing')}>
                Pair a phone
              </button>
            )}
          </Row>
        )}
        {on && pairing && (
          <div className="set-sec">
            <div className="set-pair">
              <img className="set-pair-qr" alt="Pairing QR code" src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`} />
              <div className="set-pair-txt">
                <span className="set-sub">Pairing code</span>
                <span className="set-pair-code" aria-label={`Pairing code ${pairing.code.split('').join(' ')}`}>
                  {pairing.code.slice(0, 3)} {pairing.code.slice(3)}
                </span>
                <span className="set-sub">
                  Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
                </span>
              </div>
            </div>
          </div>
        )}
      </Group>
      <Group title="Paired phones">
        {status.devices.length === 0 && <Row label="No phones yet" sub="A phone appears here once it pairs." />}
        {status.devices.map((d) => {
          const playing = status.activeOutput?.deviceId === d.id;
          return (
            <Row key={d.id} label={d.name} sub={playing ? 'Playing on this phone now' : lastSeen(d, Date.now())}>
              {playing ? (
                <button className="btn" disabled={busy} onClick={() => session.playHere()}>
                  Play on computer
                </button>
              ) : (
                d.online &&
                on && (
                  <button className="btn btn-ghost" disabled={busy || !hasTrack} title={hasTrack ? undefined : 'Start something first'} onClick={() => session.playOnDevice(d.id)}>
                    Play on phone
                  </button>
                )
              )}
              <button className="btn btn-ghost" aria-label={`Remove ${d.name}`} disabled={busy} onClick={() => run(() => api.remote.revoke(d.id), 'Could not remove the phone')}>
                Remove
              </button>
            </Row>
          );
        })}
      </Group>
    </>
  );
}

function AboutSection() {
  const { versions } = api.app;
  return (
    <Group title="About">
      <Row label="Cadence">
        <span className="set-value">{versions.app}</span>
      </Row>
      <Row label="Electron">
        <span className="set-value">{versions.electron || 'Not running in Electron'}</span>
      </Row>
      <Row label="Chromium">
        <span className="set-value">{versions.chrome || 'Unknown'}</span>
      </Row>
    </Group>
  );
}

/** Settings sections in display order; the id rides the location. */
export const SETTINGS_SECTIONS = [
  { id: 'accounts', label: 'Accounts', view: AccountsSection },
  { id: 'library', label: 'Library', view: LibrarySection },
  { id: 'audio', label: 'Audio engine', view: AudioSection },
  { id: 'player', label: 'Player', view: PlaybackSection },
  { id: 'appearance', label: 'Appearance', view: AppearanceSection },
  { id: 'phone', label: 'Phone', view: PhoneSection },
  { id: 'about', label: 'About', view: AboutSection },
] as const satisfies readonly { id: SettingsSection; label: string; view: () => ReactNode }[];

/**
 * The Settings page: a section list on the left, the chosen section's
 * controls on the right. Every control here changes something real; a
 * section only exists once the app has something to manage in it.
 */
export function SettingsView({ section, onSection }: { section: SettingsSection; onSection(next: SettingsSection): void }) {
  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  const View = current.view;
  return (
    <div className="src set-page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <div className="set-layout">
        <nav className="set-nav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.id} className={`side-row ${s.id === current.id ? 'is-active' : ''}`} aria-current={s.id === current.id ? 'page' : undefined} onClick={() => onSection(s.id)}>
              <span className="side-row-label">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="set-body">
          <View />
        </div>
      </div>
    </div>
  );
}
