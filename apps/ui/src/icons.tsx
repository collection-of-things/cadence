interface P {
  size?: number;
}

function Svg({ size = 20, children, label }: P & { children: React.ReactNode; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined}>
      {children}
    </svg>
  );
}

export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 5.5v13a.6.6 0 0 0 .92.5l10.2-6.5a.6.6 0 0 0 0-1L8.92 5a.6.6 0 0 0-.92.5Z" fill="currentColor" />
  </Svg>
);
export const PauseIcon = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" />
    <rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" />
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
    <path d="M3 6.5h2.6c5.6 0 7.4 11 13 11h1.9M3 17.5h2.6c2.2 0 3.8-2 5-4.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
    <path d="m17.5 3.8 3.5 3.4-3.5 3.4M17.5 14.1l3.5 3.4-3.5 3.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </Svg>
);
export const RepeatIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9.5a4 4 0 0 1 4-4h9.5M20 14.5a4 4 0 0 1-4 4H6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
    <path d="m14.5 2.5 3 3-3 3M9.5 15.5l-3 3 3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </Svg>
);
export const VolumeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9.2v5.6a1 1 0 0 0 1 1h2.4l4.6 3.7a.6.6 0 0 0 1-.47V4.97a.6.6 0 0 0-1-.47L7.4 8.2H5a1 1 0 0 0-1 1Z" fill="currentColor" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
  </Svg>
);
export const MuteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9.2v5.6a1 1 0 0 0 1 1h2.4l4.6 3.7a.6.6 0 0 0 1-.47V4.97a.6.6 0 0 0-1-.47L7.4 8.2H5a1 1 0 0 0-1 1Z" fill="currentColor" />
    <path d="m16.5 9.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </Svg>
);
export const QueueIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h10M4 17h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    <path d="M18.5 12.2v6.1c0 .5.55.8.97.5l2.4-1.7a.6.6 0 0 0 0-1l-2.4-1.7a.6.6 0 0 0-.97.5Z" fill="currentColor" transform="translate(-1.5 0)" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </Svg>
);
export const UpIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 14 6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </Svg>
);
export const DownIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 10 6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </Svg>
);
export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="5.5" stroke="currentColor" strokeWidth="1.7" fill="none" />
    <path d="m15 15 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </Svg>
);
export const FolderIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 6.5a2 2 0 0 1 2-2h3l2 2.5h8a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" stroke="currentColor" strokeWidth="1.6" fill="none" />
  </Svg>
);
export const NoteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 18.5V6l11-2.5V16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <ellipse cx="6.5" cy="18.5" rx="2.5" ry="2" fill="currentColor" />
    <ellipse cx="17.5" cy="16" rx="2.5" ry="2" fill="currentColor" />
  </Svg>
);
