/**
 * IPC channel names shared between main and preload. Renderer code never
 * sees these — they are wrapped by the window.cadence contextBridge API.
 */
export const IpcChannels = {
  command: "cadence:command",
  snapshot: "cadence:snapshot",
  queue: "cadence:queue",
  capabilities: "cadence:capabilities",
  event: "cadence:event",
  libraryTracks: "cadence:library:tracks",
  libraryAlbums: "cadence:library:albums",
  libraryArtists: "cadence:library:artists",
  libraryTrack: "cadence:library:track",
  libraryAddFolders: "cadence:library:add-folders",
  libraryScan: "cadence:library:scan",
  libraryRoots: "cadence:library:roots",
  scanProgress: "cadence:library:scan-progress",
  routeSignIn: "cadence:routes:sign-in",
  routeSignOut: "cadence:routes:sign-out",
  windowMinimize: "cadence:window:minimize",
  windowToggleMaximize: "cadence:window:toggle-maximize",
  windowClose: "cadence:window:close",
  audioSetEq: "cadence:audio:set-eq",
  audioListDevices: "cadence:audio:list-devices",
  audioSetDevice: "cadence:audio:set-device",
} as const;
