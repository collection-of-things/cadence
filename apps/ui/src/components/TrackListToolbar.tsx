import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrackRef } from '@cadence/protocol';
import { SearchIcon, SortIcon } from '../icons';

type Sort = 'track' | 'title' | 'duration';
const SORT_LABEL: Record<Sort, string> = { track: 'Track order', title: 'Title', duration: 'Duration' };
const NEXT_SORT: Record<Sort, Sort> = { track: 'title', title: 'duration', duration: 'track' };

interface ToolbarProps {
  filter: string | null;
  onFilter(next: string | null): void;
  sort: Sort;
  onSort(next: Sort): void;
}

/**
 * Filter and sort state for a track list; pass `controls` to TrackListToolbar.
 * `tracks` may be null while the list loads.
 */
export function useTrackListControls(tracks: readonly TrackRef[] | null): { shown: TrackRef[]; controls: ToolbarProps } {
  const [filter, onFilter] = useState<string | null>(null);
  const [sort, onSort] = useState<Sort>('track');

  const shown = useMemo(() => {
    const q = filter?.trim().toLowerCase();
    const list = q ? (tracks ?? []).filter((t) => t.title.toLowerCase().includes(q)) : [...(tracks ?? [])];
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'duration') list.sort((a, b) => a.durationMs - b.durationMs);
    return list;
  }, [tracks, filter, sort]);

  return { shown, controls: { filter, onFilter, sort, onSort } };
}

/** Search-in-list and sort controls above an album or playlist's tracks. */
export function TrackListToolbar({ filter, onFilter, sort, onSort }: ToolbarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const filtering = filter !== null;

  useEffect(() => {
    if (filtering) inputRef.current?.focus();
  }, [filtering]);

  return (
    <div className="list-toolbar">
      {filter === null ? (
        <button className="ghost-btn" aria-label="Filter tracks" title="Filter tracks" onClick={() => onFilter('')}>
          <SearchIcon size={17} />
        </button>
      ) : (
        <label className="list-filter">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            aria-label="Filter tracks"
            placeholder="Filter tracks"
            value={filter}
            onChange={(e) => onFilter(e.currentTarget.value)}
            onBlur={(e) => !e.currentTarget.value && onFilter(null)}
            onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onFilter(null))}
          />
        </label>
      )}
      <button className="ghost-btn" aria-label={`Sort: ${SORT_LABEL[sort]}`} title={`Sort: ${SORT_LABEL[sort]}`} onClick={() => onSort(NEXT_SORT[sort])}>
        <SortIcon size={17} />
        {sort !== 'track' && <span className="ghost-btn-text">{SORT_LABEL[sort]}</span>}
      </button>
    </div>
  );
}
