/** Dependencies for turning a main-window close into a complete app quit. */
export interface QuitGuardDeps {
  /** Subscribe to the app's before-quit event. */
  onBeforeQuit(cb: () => void): void;
  /** Subscribe to the main window's close event. */
  onWindowClose(cb: (e: { preventDefault(): void }) => void): void;
  /** Quit the application and its playback services. */
  quitApp(): void;
}

/** Returned arming hook for explicit quit paths. */
export interface QuitGuard {
  /** Mark the application as quitting. */
  requestQuit(): void;
}

/** Make a window-manager close quit the app, while allowing the resulting close through. */
export function wireQuitGuard(deps: QuitGuardDeps): QuitGuard {
  let quitting = false;
  deps.onBeforeQuit(() => { quitting = true; });
  deps.onWindowClose((event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    deps.quitApp();
  });
  return { requestQuit: () => { quitting = true; } };
}
