import { globalShortcut } from "electron";
import type { Coordinator } from "./coordinator/coordinator.js";

/**
 * OS-level media keys, best-effort. globalShortcut support varies by
 * platform/desktop environment — registration failures are ignored. In-page
 * transport (navigator.mediaSession) is the renderer's job; it can call
 * window.cadence.sendCommand for the same effect.
 */
export function registerMediaKeys(coordinator: Coordinator): () => void {
  const bindings: [accelerator: string, action: () => void][] = [
    [
      "MediaPlayPause",
      () => {
        const status = coordinator.getSnapshot().status;
        void coordinator.handleCommand({ kind: status === "playing" ? "pause" : "play" });
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
