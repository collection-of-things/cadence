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
