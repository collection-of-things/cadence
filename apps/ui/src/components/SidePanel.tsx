import { useEffect, useState, type CSSProperties } from 'react';
import { useUi } from '../hooks';
import { CloseIcon } from '../icons';
import { Lyrics } from './Lyrics';
import { QueuePanel } from './QueuePanel';
import { useTrackLyrics } from './useTrackLyrics';
import './lyrics.css';

export type PanelTab = 'lyrics' | 'queue';

/** Matches --shell-move in motion.css. */
export const SHELL_MOVE_MS = 260;

/** True while the panel is open and through its closing slide, so it can animate out. */
export function usePanelMounted(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), SHELL_MOVE_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return open || mounted;
}

interface SidePanelProps {
  /** False while it plays its closing slide. */
  open: boolean;
  tab: PanelTab;
  onTab(tab: PanelTab): void;
  onClose(): void;
}

/**
 * The one right-hand panel beneath the stage, mirroring the sidebar: Lyrics
 * and Up Next share it as tabs instead of stacking two overlays.
 */
export function SidePanel({ open, tab, onTab, onClose }: SidePanelProps) {
  const track = useUi((s) => s.snapshot.current?.track);
  const lyrics = useTrackLyrics(track);
  const tabs: { id: PanelTab; label: string }[] = [
    { id: 'lyrics', label: 'Lyrics' },
    { id: 'queue', label: 'Up Next' },
  ];

  return (
    <aside className={`side-panel lyrics-rail ${open ? 'is-open' : ''}`} aria-label="Lyrics and queue">
      <header className="side-panel-head">
        <div
          className="side-switch panel-tabs"
          role="tablist"
          aria-label="Panel"
          style={{ '--n': tabs.length, '--i': tabs.findIndex((t) => t.id === tab) } satisfies CSSProperties}
        >
          <span className="side-switch-ind" aria-hidden="true" />
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'is-on' : ''}
              {...(t.id === 'queue' ? { 'data-queue-toggle': '' } : {})}
              onClick={() => onTab(t.id)}
            >
              <span className="side-switch-label">{t.label}</span>
            </button>
          ))}
        </div>
        <button className="icon-btn" aria-label="Close panel" title="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </header>
      <div className="side-panel-body" role="tabpanel">
        {tab === 'queue' ? (
          <QueuePanel />
        ) : track ? (
          <Lyrics key={track.id} raw={lyrics} />
        ) : (
          <div className="lyrics-empty">Play something to see its lyrics.</div>
        )}
      </div>
    </aside>
  );
}
