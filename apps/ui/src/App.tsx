import { useEffect } from 'react';
import { session } from './app';
import { LibraryView } from './components/LibraryView';
import { NowPlaying } from './components/NowPlaying';
import { QueuePanel } from './components/QueuePanel';
import { SettingsSheet } from './components/SettingsSheet';
import { Toasts } from './components/Toasts';
import { positionNow, useUi } from './hooks';
import { QueueIcon } from './icons';
import { extractPalette, DEFAULT_PALETTE } from './palette';

function TopBar() {
  const view = useUi((s) => s.view);
  const open = useUi((s) => s.queueOpen);
  const count = useUi((s) => s.queue.items.length);
  return (
    <header className="topbar">
      <span className="brand">Cadence</span>
      <nav className="nav" aria-label="Views">
        <button className={`nav-btn ${view === 'now' ? 'on' : ''}`} onClick={() => session.setView('now')}>
          Now Playing
        </button>
        <button className={`nav-btn ${view === 'library' ? 'on' : ''}`} onClick={() => session.setView('library')}>
          Library
        </button>
      </nav>
      <button
        className={`icon-btn nav-q ${open ? 'on' : ''}`}
        aria-label="Toggle queue"
        aria-pressed={open}
        onClick={() => session.setQueueOpen(!open)}
      >
        <QueueIcon size={19} />
        {count > 0 && <span className="q-count">{count}</span>}
      </button>
      <SettingsSheet />
    </header>
  );
}

export function App() {
  const view = useUi((s) => s.view);
  const artUrl = useUi((s) => s.snapshot.current?.track.artwork?.url);

  useEffect(() => {
    let live = true;
    if (!artUrl) {
      session.setPalette(DEFAULT_PALETTE);
      return;
    }
    void extractPalette(artUrl).then((p) => {
      if (live) session.setPalette(p ?? DEFAULT_PALETTE);
    });
    return () => {
      live = false;
    };
  }, [artUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? '';
      if (tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        if (type !== 'range') return; // let search/text fields keep keys
        if (e.key.startsWith('Arrow')) return; // native slider behavior
      }
      const s = session.store.getState();
      switch (e.key) {
        case ' ':
          if (tag === 'BUTTON') return; // focused buttons activate natively
          e.preventDefault();
          session.togglePlay();
          break;
        case 'ArrowRight':
          session.seek(positionNow() + (e.shiftKey ? 30_000 : 5_000));
          break;
        case 'ArrowLeft':
          session.seek(positionNow() - (e.shiftKey ? 30_000 : 5_000));
          break;
        case 'ArrowUp':
          e.preventDefault();
          session.setVolume(s.snapshot.volume + 0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          session.setVolume(s.snapshot.volume - 0.05);
          break;
        case 'q':
        case 'Q':
          session.setQueueOpen(!s.queueOpen);
          break;
        case 'm':
        case 'M':
          session.toggleMute();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <main className="main">{view === 'library' ? <LibraryView /> : <NowPlaying />}</main>
      <QueuePanel />
      <Toasts />
    </div>
  );
}
