import { useEffect, useState, type CSSProperties } from 'react';
import type { LibraryAlbum, TrackRef } from '@cadence/protocol';
import { api, session } from '../app';
import { formatTime } from '../format';
import { useUi } from '../hooks';
import { NoteIcon, PlayIcon, PlusIcon, ShuffleIcon } from '../icons';
import { DEFAULT_PALETTE, extractPalette, type Rgb } from '../palette';
import './home.css';

interface AlbumViewProps {
  album: LibraryAlbum;
  onBack(): void;
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function TrackRow({ track, index, onPlay }: { track: TrackRef; index: number; onPlay(): void }) {
  return (
    <div
      className="album-track-row"
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onPlay();
        }
      }}
    >
      <span className="album-track-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="album-track-copy">
        <span className="album-track-title">{track.title}</span>
        <span className="album-track-artist">{track.artists.map((artist) => artist.name).join(', ')}</span>
      </span>
      <span className="album-track-duration">{formatTime(track.durationMs)}</span>
      <button
        className="album-track-add"
        aria-label={`Add ${track.title} next`}
        title="Play next"
        onClick={(event) => {
          event.stopPropagation();
          session.insertNext(track);
        }}
      >
        <PlusIcon size={16} />
      </button>
    </div>
  );
}

export function AlbumView({ album, onBack }: AlbumViewProps) {
  const [tracks, setTracks] = useState<TrackRef[] | null>(null);
  const [albumPalette, setAlbumPalette] = useState<Rgb[]>(DEFAULT_PALETTE);
  const scan = useUi((s) => s.scan);

  useEffect(() => {
    let live = true;
    setTracks(null);
    void api.library.tracks({ album: album.title, artist: album.artist }).then((result) => {
      if (live) setTracks(result);
    }).catch(() => {
      if (live) setTracks([]);
    });
    return () => {
      live = false;
    };
  }, [album.id, album.title, album.artist, scan.phase]);

  useEffect(() => {
    let live = true;
    if (!album.artwork?.url) {
      setAlbumPalette(DEFAULT_PALETTE);
      return;
    }
    void extractPalette(album.artwork.url).then((result) => {
      if (live) setAlbumPalette(result ?? DEFAULT_PALETTE);
    });
    return () => {
      live = false;
    };
  }, [album.artwork?.url]);

  const firstTrack = tracks?.[0];
  const genre = firstTrack?.genre?.[0];
  const year = album.year ?? firstTrack?.year;
  const totalDuration = tracks?.reduce((sum, track) => sum + track.durationMs, 0) ?? 0;
  const tone = albumPalette[0] ?? DEFAULT_PALETTE[0]!;
  const pageStyle = { '--album-rgb': tone.join(' ') } as CSSProperties;
  const origin = { kind: 'album' as const, id: album.id, name: album.title };

  const playAll = () => {
    if (tracks?.length) session.playTracks(tracks, 0, origin);
  };

  return (
    <div className="album-page" style={pageStyle}>
      <div className="album-page-glow" aria-hidden="true" />
      <div className="album-page-scroll">
        <button className="album-back" onClick={onBack}>
          <BackArrow /> <span>Back</span>
        </button>
        <section className="album-hero">
          <div className="album-artwork-wrap">
            {album.artwork ? <img className="album-artwork" src={album.artwork.url} alt={`${album.title} album artwork`} /> : <div className="album-artwork album-artwork-empty"><NoteIcon size={58} /></div>}
          </div>
          <div className="album-details">
            <span className="album-eyebrow">ALBUM</span>
            <h1>{album.title}</h1>
            <p className="album-artist-name">{album.artist}</p>
            <div className="album-facts" aria-label="Album details">
              {genre && <span className="album-fact">{genre}</span>}
              {year && <span className="album-fact">{year}</span>}
              <span className="album-fact">{tracks?.length ?? album.trackCount} tracks</span>
              {tracks && <span className="album-fact">{formatTime(totalDuration)}</span>}
            </div>
            <div className="album-actions">
              <button className="album-shuffle" aria-label="Shuffle album" title="Shuffle album" disabled={!tracks?.length} onClick={() => tracks?.length && session.playTracks(shuffled(tracks), 0, origin)}>
                <ShuffleIcon size={18} />
              </button>
              <button className="album-play" disabled={!tracks?.length} onClick={playAll}>
                <PlayIcon size={19} /> <span>Play album</span>
              </button>
              <button className="album-add" aria-label="Add album to queue" title="Add album to queue" disabled={!tracks?.length} onClick={() => tracks?.forEach((track) => session.append(track))}>
                <PlusIcon size={19} />
              </button>
            </div>
          </div>
        </section>

        <section className="album-tracklist" aria-label={`${album.title} track list`}>
          <div className="album-tracklist-head">
            <h2>Tracks</h2>
            {tracks && <span>{tracks.length} songs</span>}
          </div>
          {tracks === null ? (
            <div className="album-track-status" role="status">Loading tracks…</div>
          ) : tracks.length === 0 ? (
            <div className="album-track-status">No tracks found for this album.</div>
          ) : (
            <div className="album-track-list">
              {tracks.map((track, index) => <TrackRow key={track.id} track={track} index={index} onPlay={() => session.playTracks(tracks, index, origin)} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function BackArrow() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.8 5.5-6.5 6.5 6.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
