/**
 * Close-to-tray policy for the main window.
 *
 * A user closing the window hides it — provider playback must survive the
 * window per the v3 design. A real quit must still close it, and quit can
 * arrive over several paths: the tray Quit item, app.quit(), Cmd+Q, or an
 * OS session end. `before-quit` fires for every quit path, so it arms the
 * guard together with the explicit tray item; the window `close` handler
 * only hides while the guard is unarmed.
 *
 * The latch is one-way: once armed, closes always proceed. That is right
 * for quit — it is irrevocable once before-quit has fired. A future
 * before-quit listener that preventDefaults would make the next user close
 * perform a real close instead of a hide; no such listener exists today.
 */
export interface CloseToTrayDeps {
  /** Subscribe a callback to the app's before-quit event. */
  onBeforeQuit(cb: () => void): void;
  /** Subscribe a callback to the window's close event. */
  onWindowClose(cb: (e: { preventDefault(): void }) => void): void;
  /** Hide the main window (the close-to-tray behaviour). */
  hideWindow(): void;
}

/** Returned arming hook for quit paths that bypass before-quit's listeners. */
export interface QuitGuard {
  /** Mark the app as quitting — the next window close must proceed. */
  requestQuit(): void;
}

/**
 * Wire the close-to-tray policy onto app + window events. Returns the
 * arming hook for the tray Quit item.
 */
export function wireCloseToTray(deps: CloseToTrayDeps): QuitGuard {
  let quitting = false;
  deps.onBeforeQuit(() => {
    quitting = true;
  });
  deps.onWindowClose((e) => {
    if (quitting) return;
    e.preventDefault();
    deps.hideWindow();
  });
  return {
    requestQuit: () => {
      quitting = true;
    },
  };
}
