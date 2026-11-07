import { describe, expect, it } from "vitest";
import { wireCloseToTray } from "../src/quit-guard.js";

/**
 * Regression for the app.quit() hang: on main, the window 'close' handler
 * preventDefaulted unless the tray menu's private `quitting` flag was set,
 * and only that menu item set it. Programmatic quit (app.quit(), Cmd+Q)
 * emits before-quit but never armed the flag, so the close was vetoed, the
 * window merely hid, and the process never exited.
 *
 * The tests replay Electron's event order against the extracted policy.
 */
interface Rig {
  fireBeforeQuit(): void;
  fireClose(): { prevented: boolean };
  hidden: number;
  requestQuit(): void;
}

function rig(): Rig {
  const listeners: { beforeQuit: (() => void)[]; close: ((e: { preventDefault(): void }) => void)[] } = {
    beforeQuit: [],
    close: [],
  };
  const rigState = { hidden: 0 };
  const guard = wireCloseToTray({
    onBeforeQuit: (cb) => listeners.beforeQuit.push(cb),
    onWindowClose: (cb) => listeners.close.push(cb),
    hideWindow: () => {
      rigState.hidden += 1;
    },
  });
  return {
    fireBeforeQuit: () => {
      for (const cb of listeners.beforeQuit) cb();
    },
    fireClose: () => {
      let prevented = false;
      const e = { preventDefault: () => (prevented = true) };
      for (const cb of listeners.close) cb(e);
      return { prevented };
    },
    get hidden() {
      return rigState.hidden;
    },
    requestQuit: guard.requestQuit,
  };
}

describe("close-to-tray policy", () => {
  it("hides the window instead of closing while the app runs", () => {
    const r = rig();
    const { prevented } = r.fireClose();
    expect(prevented).toBe(true);
    expect(r.hidden).toBe(1);
  });

  it("lets the window close after before-quit (the app.quit() path)", () => {
    const r = rig();
    // app.quit() emits before-quit, then Electron closes each window.
    r.fireBeforeQuit();
    const { prevented } = r.fireClose();
    expect(prevented).toBe(false);
    expect(r.hidden).toBe(0);
  });

  it("lets the window close after the tray Quit item", () => {
    const r = rig();
    r.requestQuit();
    const { prevented } = r.fireClose();
    expect(prevented).toBe(false);
    expect(r.hidden).toBe(0);
  });
});
