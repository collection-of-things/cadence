import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueueItem } from '@cadence/protocol';
import { session } from '../app';
import { formatTime } from '../format';
import { useUi } from '../hooks';
import { displayOrder } from '../store';
import { CloseIcon, DownIcon, UpIcon } from '../icons';
import { providerForRoute, RouteBadge } from './RouteBadge';

function QueueRow({ item, index, current }: { item: QueueItem; index: number; current: boolean }) {
  const shuffle = useUi((s) => s.queue.shuffle);
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
      <span className={`q-eq ${current ? 'on' : ''}`} aria-hidden="true">
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
          onClick={() => session.moveQueueItem(index, index - 1)}
        >
          <UpIcon size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label="Move down"
          disabled={shuffle || index >= count - 1}
          title={shuffle ? 'Reorder unavailable while shuffled' : 'Move down'}
          onClick={() => session.moveQueueItem(index, index + 1)}
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

export function QueuePanel() {
  const open = useUi((s) => s.queueOpen);
  const queue = useUi((s) => s.queue);
  const currentQid = useUi((s) => s.snapshot.current?.queueId);
  const npExpanded = useUi((s) => s.nowPlayingExpanded);
  const scrollRef = useRef<HTMLDivElement>(null);
  const order = displayOrder(queue);
  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 10,
  });

  // Land on the playing row when the panel opens.
  useEffect(() => {
    if (!open) return;
    const pos = order.indexOf(queue.currentIndex);
    if (pos > 0) virtualizer.scrollToIndex(pos, { align: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return createPortal(
    <aside className={`queue ${open ? 'open' : ''} ${npExpanded ? 'over-now' : ''}`} aria-hidden={!open} aria-label="Play queue">
      <div className="q-head">
        <h2>Up Next</h2>
        <span className="q-owner">{queue.owner === 'provider' ? 'provider queue' : `${order.length} tracks`}</span>
        <button className="icon-btn" aria-label="Close queue" onClick={() => session.setQueueOpen(false)}>
          <CloseIcon size={16} />
        </button>
      </div>
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
    </aside>,
    document.body,
  );
}
