import type { ReactNode } from 'react';
import type { ArtworkRef } from '@cadence/protocol';
import { ChevronIcon, NoteIcon, PlayIcon } from '../icons';
import { useRail } from './useRail';
import './home.css';

/**
 * A titled row of cards that scrolls sideways, with back/forward arrows when
 * the cards overflow. `head` is the heading (see ShelfTitle); `label` names
 * the shelf for assistive tech.
 */
export function Shelf({ head, label, children }: { head: ReactNode; label: string; children: ReactNode }) {
  const { railRef, edges, onScroll, step } = useRail(children);
  const scrolls = !(edges.start && edges.end);
  return (
    <section className="shelf" aria-label={label}>
      <div className="shelf-head">
        {head}
        {scrolls && (
          <div className="shelf-arrows">
            <button className="round-btn" aria-label={`Scroll ${label} back`} disabled={edges.start} onClick={() => step(-1)}>
              <ChevronIcon dir="left" size={18} />
            </button>
            <button className="round-btn" aria-label={`Scroll ${label} forward`} disabled={edges.end} onClick={() => step(1)}>
              <ChevronIcon dir="right" size={18} />
            </button>
          </div>
        )}
      </div>
      <div className="shelf-rail" ref={railRef} onScroll={onScroll}>
        {children}
      </div>
    </section>
  );
}

/** The usual shelf heading: a title with an optional quiet subtitle beside it. */
export function ShelfTitle({ title, subtitle }: { title: string; subtitle?: string | undefined }) {
  return (
    <div className="shelf-title">
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

/** A cover image, or a note glyph when there is none. */
export function Cover({ art, eager = false }: { art: ArtworkRef | undefined; eager?: boolean }) {
  return art
    ? <img src={art.url} alt="" loading={eager ? 'eager' : 'lazy'} draggable={false} />
    : <span className="cover-empty"><NoteIcon size={40} /></span>;
}

interface SquareCardProps {
  title: string;
  /** Second line: the artist, curator or description. */
  sub?: string | undefined;
  art: ArtworkRef | undefined;
  /** Accessible name of the card, e.g. "Open Blue by Joni Mitchell". */
  label: string;
  onOpen(): void;
  /** Adds a play button over the cover. */
  onPlay?: (() => void) | undefined;
  eager?: boolean;
}

/** Square cover with title and a second line below it. */
export function SquareCard({ title, sub, art, label, onOpen, onPlay, eager = false }: SquareCardProps) {
  return (
    <div className="square-card">
      <button className="square-open" onClick={onOpen} aria-label={label}>
        <span className="square-art"><Cover art={art} eager={eager} /></span>
        <span className="square-title">{title}</span>
        {sub && <span className="square-artist">{sub}</span>}
      </button>
      {onPlay && (
        <button className="card-play" aria-label={`Play ${title}`} onClick={onPlay}>
          <PlayIcon size={18} />
        </button>
      )}
    </div>
  );
}

/** Placeholder for a shelf that is still loading. */
export function SkeletonShelf({ tall = false }: { tall?: boolean }) {
  return (
    <section className="shelf" aria-hidden="true">
      <div className="shelf-head"><span className="skeleton skeleton-title" /></div>
      <div className="shelf-rail">
        {Array.from({ length: 6 }, (_, i) => <span key={i} className={`skeleton ${tall ? 'skeleton-poster' : 'skeleton-square'}`} />)}
      </div>
    </section>
  );
}

/** Placeholder rows for a track list that is still loading. */
export function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <div className="track-list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <span key={i} className="skeleton skeleton-row" />)}
    </div>
  );
}

/**
 * Centred message for an empty, failed or signed-out page. `alert` announces
 * it as an error; children go under the text (a Sign in button, say).
 */
export function EmptyState({ title, body, alert = false, children }: {
  title: string;
  body: string;
  alert?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state" role={alert ? 'alert' : 'status'}>
      <span className="empty-icon"><NoteIcon size={30} /></span>
      <h2>{title}</h2>
      <p>{body}</p>
      {children}
    </div>
  );
}
