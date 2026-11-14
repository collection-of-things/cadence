import { describe, expect, it } from "vitest";
import { wireQuitGuard } from "../src/quit-guard.js";

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
  quitCalls: number;
  requestQuit(): void;
}

function rig(): Rig {
  const listeners: { beforeQuit: (() => void)[]; close: ((e: { preventDefault(): void }) => void)[] } = {
    beforeQuit: [],
    close: [],
  };
  const rigState = { quitCalls: 0 };
  const guard = wireQuitGuard({
    onBeforeQuit: (cb) => listeners.beforeQuit.push(cb),
    onWindowClose: (cb) => listeners.close.push(cb),
    quitApp: () => { rigState.quitCalls += 1; },
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
    get quitCalls() { return rigState.quitCalls; },
    requestQuit: guard.requestQuit,
  };
}

describe("quit policy", () => {
  it("quits the app when the window is closed", () => {
    const r = rig();
    const { prevented } = r.fireClose();
    expect(prevented).toBe(true);
    expect(r.quitCalls).toBe(1);
  });

  it("lets the window close after before-quit (the app.quit() path)", () => {
    const r = rig();
    // app.quit() emits before-quit, then Electron closes each window.
    r.fireBeforeQuit();
    const { prevented } = r.fireClose();
    expect(prevented).toBe(false);
  });

  it("lets the window close after the tray Quit item", () => {
    const r = rig();
    r.requestQuit();
    const { prevented } = r.fireClose();
    expect(prevented).toBe(false);
  });
});
