import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueueItem } from '@cadence/protocol';
import { session } from '../session';
import { formatTime } from '../format';
import { useUi } from '../hooks';
import { displayOrder } from '../store';
import { withoutMotion } from '../instant';
import { CloseIcon, DownIcon, UpIcon } from '../icons';
import { providerForRoute, RouteBadge } from './RouteBadge';

function QueueRow({ item, index, current }: { item: QueueItem; index: number; current: boolean }) {
  const shuffle = useUi((s) => s.queue.shuffle);
  const playing = useUi((s) => s.snapshot.status === 'playing');
  const count = useUi((s) => s.queue.items.length);
  const [dragOver, setDragOver] = useState(false);
  const t = item.track;
  return (
    <div
      className={`q-row ${current ? 'now' : ''} ${dragOver ? 'drop' : ''}`}
      draggable={!shuffle}
      title={shuffle ? 'Reorder unavailable while shuffled' : undefined}
      onDragStart={(e) => {
        if (shuffle) return;
        e.dataTransfer.setData('text/cadence-qindex', String(index));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (shuffle) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (shuffle) return;
        e.preventDefault();
        setDragOver(false);
        const from = Number(e.dataTransfer.getData('text/cadence-qindex'));
        if (Number.isInteger(from) && from !== index) session.moveQueueItem(from, index);
      }}
      onClick={() => session.playQueueId(item.queueId)}
      aria-current={current || undefined}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) session.playQueueId(item.queueId);
      }}
    >
      <span className={`q-eq ${current && playing ? 'on' : ''}`} aria-hidden="true">
        <i /><i /><i />
      </span>
      {t.artwork ? <img className="q-art" src={t.artwork.url} alt="" loading="lazy" /> : <span className="q-art" />}
      <span className="q-tt">
        <span className="q-title">{t.title}</span>
        <span className="q-artist">{t.artists.map((a) => a.name).join(', ')}</span>
      </span>
      <RouteBadge provider={providerForRoute(t.route)} title={t.route} />
      <span className="q-dur">{formatTime(t.durationMs)}</span>
      <span className="q-acts" onClick={(e) => e.stopPropagation()}>
        <button
          className="icon-btn"
          aria-label="Move up"
          disabled={shuffle || index <= 0}
          title={shuffle ? 'Reorder unavailable while shuffled' : 'Move up'}
          onClick={(e) => { const btn = e.currentTarget as HTMLElement; session.moveQueueItem(index, index - 1); requestAnimationFrame(() => (btn.isConnected ? btn : (btn.closest('.q-row') as HTMLElement | null))?.focus()); }}
        >
          <UpIcon size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label="Move down"
          disabled={shuffle || index >= count - 1}
          title={shuffle ? 'Reorder unavailable while shuffled' : 'Move down'}
          onClick={(e) => { const btn = e.currentTarget as HTMLElement; session.moveQueueItem(index, index + 1); requestAnimationFrame(() => (btn.isConnected ? btn : (btn.closest('.q-row') as HTMLElement | null))?.focus()); }}
        >
          <DownIcon size={15} />
        </button>
        <button className="icon-btn" aria-label="Remove from queue" onClick={() => session.removeQueueItems([item.queueId])}>
          <CloseIcon size={15} />
        </button>
      </span>
    </div>
  );
}

/**
 * The play queue as a list: the owner line, then virtualised rows. It is
 * mounted only while shown (the side panel's Up Next tab, or Now Playing's
 * right column), and owns Escape while mounted.
 */
export function QueuePanel() {
  const queue = useUi((s) => s.queue);
  const currentQid = useUi((s) => s.snapshot.current?.queueId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const order = displayOrder(queue);
  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 10,
  });

  // Land on the playing row when the list mounts; Escape closes it.
  useEffect(() => {
    // Escape hands focus back to whatever opened the queue.
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        withoutMotion(() => session.setQueueOpen(false));
        const fallback = [...document.querySelectorAll<HTMLElement>('[data-queue-toggle]')].find((el) => el.getClientRects().length > 0);
        (opener?.isConnected && opener !== document.body ? opener : fallback)?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const pos = order.indexOf(queue.currentIndex);
    if (pos > 0) virtualizer.scrollToIndex(pos, { align: 'center' });
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside className="queue open" aria-label="Queue">
      <span className="q-owner">{queue.owner === 'provider' ? 'Playing from the provider queue' : `${order.length} ${order.length === 1 ? 'track' : 'tracks'}`}</span>
      {order.length === 0 ? (
        <div className="q-empty">Queue is empty.</div>
      ) : (
        <div className="q-scroll" ref={scrollRef}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const idx = order[vi.index]!;
              const item = queue.items[idx]!;
              return (
                <div key={item.queueId} className="q-row-wrap" style={{ transform: `translateY(${vi.start}px)` }}>
                  <QueueRow item={item} index={idx} current={item.queueId === currentQid} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
