import { globalShortcut } from "electron";
import type { PlaybackCommand, PlaybackSnapshot } from "@cadence/protocol";

/** What media keys drive: the coordinator, or a router that may send to a phone first. */
export interface MediaKeyTarget {
  getSnapshot(): PlaybackSnapshot;
  /** True when this key should pause (something is playing on the active device). */
  isPlaying?(): boolean;
  handleCommand(cmd: PlaybackCommand): Promise<void>;
}

/**
 * OS-level media keys, best-effort. globalShortcut support varies by
 * platform/desktop environment — registration failures are ignored. In-page
 * transport (navigator.mediaSession) is the renderer's job; it can call
 * window.cadence.sendCommand for the same effect.
 */
export function registerMediaKeys(coordinator: MediaKeyTarget): () => void {
  const bindings: [accelerator: string, action: () => void][] = [
    [
      "MediaPlayPause",
      () => {
        const playing = coordinator.isPlaying?.() ?? coordinator.getSnapshot().status === "playing";
        void coordinator.handleCommand({ kind: playing ? "pause" : "play" });
      },
    ],
    ["MediaNextTrack", () => void coordinator.handleCommand({ kind: "next" })],
    ["MediaPreviousTrack", () => void coordinator.handleCommand({ kind: "previous" })],
    ["MediaStop", () => void coordinator.handleCommand({ kind: "stop" })],
  ];
  const registered: string[] = [];
  for (const [accelerator, action] of bindings) {
    try {
      if (globalShortcut.register(accelerator, action)) {
        registered.push(accelerator);
      }
    } catch {
      // Not every desktop environment lets apps grab media keys.
    }
  }
  return () => {
    for (const accelerator of registered) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        // best-effort
      }
    }
  };
}
