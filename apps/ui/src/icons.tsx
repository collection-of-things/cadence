interface P {
  size?: number;
}

const SW = 1.5;

function Svg({ size = 20, children, label }: P & { children: React.ReactNode; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined}>
      {children}
    </svg>
  );
}

/** Stroked path shorthand: currentColor, 1.5px, round caps/joins. */
function strokeProps() {
  return { stroke: 'currentColor', strokeWidth: SW, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
}

/* Transport glyphs stay filled — they sit on the solid accent/quiet
   buttons and need the optical weight of a solid shape. Everything else
   is outline at one stroke weight. */

export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 5.6v12.8a.65.65 0 0 0 1 .55l10.2-6.4a.65.65 0 0 0 0-1.1L9 5.05a.65.65 0 0 0-1 .55Z" fill="currentColor" />
  </Svg>
);
export const PauseIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6.9" y="5" width="3.5" height="14" rx="1.1" fill="currentColor" />
    <rect x="13.6" y="5" width="3.5" height="14" rx="1.1" fill="currentColor" />
  </Svg>
);
export const NextIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6.2v11.6a.5.5 0 0 0 .78.42l8.6-5.8a.5.5 0 0 0 0-.84l-8.6-5.8A.5.5 0 0 0 6 6.2Z" fill="currentColor" />
    <rect x="16.6" y="5.6" width="2.6" height="12.8" rx="1" fill="currentColor" />
  </Svg>
);
export const PrevIcon = (p: P) => (
  <Svg {...p}>
    <path d="M18 6.2v11.6a.5.5 0 0 1-.78.42l-8.6-5.8a.5.5 0 0 1 0-.84l8.6-5.8A.5.5 0 0 1 18 6.2Z" fill="currentColor" />
    <rect x="4.8" y="5.6" width="2.6" height="12.8" rx="1" fill="currentColor" />
  </Svg>
);
export const ShuffleIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 18h1.9c1.3 0 2.5-.6 3.3-1.7l6-8.6c.8-1.1 2-1.7 3.3-1.7h4.5" {...strokeProps()} />
    <path d="m17.5 2 4 4-4 4" {...strokeProps()} />
    <path d="M2.5 6h1.9c1.4 0 2.7.8 3.4 2" {...strokeProps()} />
    <path d="M21.5 18H17c-1.3 0-2.5-.6-3.3-1.7l-.5-.7" {...strokeProps()} />
    <path d="m17.5 14 4 4-4 4" {...strokeProps()} />
  </Svg>
);
export const RepeatIcon = (p: P) => (
  <Svg {...p}>
    <path d="m17 2 4 4-4 4" {...strokeProps()} />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" {...strokeProps()} />
    <path d="m7 22-4-4 4-4" {...strokeProps()} />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" {...strokeProps()} />
  </Svg>
);
export const VolumeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" {...strokeProps()} />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" {...strokeProps()} />
    <path d="M18.6 5.4a9.5 9.5 0 0 1 0 13.2" {...strokeProps()} />
  </Svg>
);
export const MuteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" {...strokeProps()} />
    <path d="m16 9.5 5.5 5.5M21.5 9.5 16 15" {...strokeProps()} />
  </Svg>
);
export const QueueIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 6.5h17M3.5 12h10M3.5 17.5h10" {...strokeProps()} />
    <path d="M16.8 11.4v5.7a.45.45 0 0 0 .7.38l4.3-2.85a.45.45 0 0 0 0-.76l-4.3-2.85a.45.45 0 0 0-.7.4Z" fill="currentColor" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" {...strokeProps()} />
  </Svg>
);
export const UpIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 14.5 6-6 6 6" {...strokeProps()} />
  </Svg>
);
export const DownIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" {...strokeProps()} />
  </Svg>
);
export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" {...strokeProps()} />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" {...strokeProps()} />
    <path d="m21 21-4.4-4.4" {...strokeProps()} />
  </Svg>
);
export const FolderIcon = (p: P) => (
  <Svg {...p}>
    <path
      d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
      {...strokeProps()}
    />
  </Svg>
);
export const GearIcon = (p: P) => (
  <Svg {...p}>
    <path
      d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"
      {...strokeProps()}
    />
    <circle cx="12" cy="12" r="3" {...strokeProps()} />
  </Svg>
);
export const NoteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 18V5l12-2v13" {...strokeProps()} />
    <circle cx="6" cy="18" r="3" {...strokeProps()} />
    <circle cx="18" cy="16" r="3" {...strokeProps()} />
  </Svg>
);

/* ---- shell + browse glyphs (Cider-style set) ---- */
export const HomeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.8Z" {...strokeProps()} />
  </Svg>
);
export const AlbumsIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="8" width="16" height="12" rx="2.2" {...strokeProps()} />
    <path d="M6.5 5h11M9 2.5h6" {...strokeProps()} />
  </Svg>
);
export const ArtistIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3.5" {...strokeProps()} />
    <path d="M3 19.5c.6-3 3-5 6-5s5.4 2 6 5" {...strokeProps()} />
    <circle cx="17" cy="9.5" r="2.5" {...strokeProps()} />
    <path d="M17 14.5c2.2 0 3.7 1.4 4 3.6" {...strokeProps()} />
  </Svg>
);
export const SongIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 17.5V6l10-2v11.5" {...strokeProps()} />
    <circle cx="6.5" cy="17.5" r="2.5" {...strokeProps()} />
    <circle cx="16.5" cy="15.5" r="2.5" {...strokeProps()} />
  </Svg>
);
export const SourcesIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2" {...strokeProps()} />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" {...strokeProps()} />
  </Svg>
);
export const StarIcon = ({ filled = false, ...p }: P & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="m12 3.6 2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.5l-5.1 2.7 1-5.6-4.1-4 5.7-.8L12 3.6Z"
      {...strokeProps()}
      fill={filled ? 'currentColor' : 'none'}
    />
  </Svg>
);
export const PinIcon = ({ filled = false, ...p }: P & { filled?: boolean }) => (
  <Svg {...p}>
    <path d="M9 3.5h6l-1 5.5 3.5 3.5h-11L10 9 9 3.5Z" {...strokeProps()} fill={filled ? 'currentColor' : 'none'} />
    <path d="M12 12.5v8" {...strokeProps()} />
  </Svg>
);
export const ClockIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" {...strokeProps()} />
    <path d="M12 7.5V12l3 2" {...strokeProps()} />
  </Svg>
);
export const ChevronIcon = ({ dir = 'down', ...p }: P & { dir?: 'down' | 'up' | 'left' | 'right' }) => (
  <Svg {...p}>
    <path
      d={{ down: 'm6 9.5 6 6 6-6', up: 'm6 14.5 6-6 6 6', left: 'm14.5 6-6 6 6 6', right: 'm9.5 6 6 6-6 6' }[dir]}
      {...strokeProps()}
      strokeWidth={1.9}
    />
  </Svg>
);
export const MoreIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.6" fill="currentColor" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.6" fill="currentColor" />
  </Svg>
);
export const LyricsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6.5L8 21v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" {...strokeProps()} />
    <path d="M9.6 8.4 8.4 11h1.8v2H7.8v-2.2l1-2.4h.8ZM14.6 8.4 13.4 11h1.8v2h-2.4v-2.2l1-2.4h.8Z" fill="currentColor" />
  </Svg>
);
export const SidebarIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" {...strokeProps()} />
    <path d="M9 4.8v14.4" {...strokeProps()} />
    <path d="M5.8 8.2h1M5.8 10.6h1" {...strokeProps()} />
  </Svg>
);
export const CollapseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14 4v6h6M10 20v-6H4M14 10l6.5-6.5M10 14l-6.5 6.5" {...strokeProps()} />
  </Svg>
);
export const ExpandIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15 4h5v5M9 20H4v-5M20 4l-7 7M4 20l7-7" {...strokeProps()} />
  </Svg>
);
export const ScreenIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" {...strokeProps()} />
    <path d="M8.5 20h7M12 16.5V20" {...strokeProps()} />
  </Svg>
);
export const SortIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 4v15m0 0-3-3m3 3 3-3M13 6h7M13 11h5M13 16h3" {...strokeProps()} />
  </Svg>
);
export const RefreshIcon = (p: P) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" {...strokeProps()} />
    <path d="M19.5 4v4h-4" {...strokeProps()} />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" {...strokeProps()} strokeWidth={1.9} />
  </Svg>
);
export const QueueNextIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h11M4 11h11M4 16h6" {...strokeProps()} />
    <path d="M17 13v7M13.5 16.5h7" {...strokeProps()} />
  </Svg>
);
export const ArtOnlyIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" {...strokeProps()} />
    <path d="M7.5 5v14M16.5 5v14" {...strokeProps()} />
  </Svg>
);
