/**
 * Preload for hidden provider playback views. Bundled to provider.js.
 * Exposes a single narrow channel the injected controller uses to report
 * player state to the main process. No other surface is exposed.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__cadenceBridge", {
  emit: (name: string, data: unknown): void => {
    if (typeof name !== "string" || name.length > 64) return;
    ipcRenderer.send("cadence:provider-event", name, data);
  },
});
