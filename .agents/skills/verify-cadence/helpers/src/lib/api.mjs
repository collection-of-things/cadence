// api.mjs — typed wrappers over the window.cadence preload bridge.
// State reads and fixture setup go through here; user actions in flows
// prefer real UI clicks (see flows/*.mjs) — the API is for asserting and
// for paths with no UI handle (library.scan of a fixture dir, device info).
import { waitFor } from "./env.mjs";

export const snapshot = (page) => page.evaluate(() => window.cadence.getSnapshot());
export const queue = (page) => page.evaluate(() => window.cadence.getQueue());
export const capabilities = (page) => page.evaluate(() => window.cadence.getCapabilities());
export const send = (page, cmd) => page.evaluate((c) => window.cadence.sendCommand(c), cmd);
export const scan = (page, paths) => page.evaluate((p) => window.cadence.library.scan(p), paths);
export const roots = (page) => page.evaluate(() => window.cadence.library.roots());
export const tracks = (page, q = {}) => page.evaluate((qq) => window.cadence.library.tracks(qq), q);
export const albums = (page, q = {}) => page.evaluate((qq) => window.cadence.library.albums(qq), q);
export const artists = (page, q = {}) => page.evaluate((qq) => window.cadence.library.artists(qq), q);
export const listDevices = (page) => page.evaluate(() => window.cadence.audio.listDevices());
export const setDevice = (page, name) => page.evaluate((n) => window.cadence.audio.setDevice(n), name);
export const searchProvider = (page, route, text) =>
  page.evaluate(({ route, text }) => window.cadence.search.provider(route, text), { route, text });
export const signIn = (page, route) => page.evaluate((r) => window.cadence.routes.signIn(r), route);

export async function waitStatus(page, status, timeout = 12_000) {
  return waitFor(
    async () => {
      const s = await snapshot(page);
      return s.status === status ? s : null;
    },
    { timeout, what: `status=${status}` },
  );
}

export async function waitPosition(page, atLeastMs, timeout = 12_000) {
  return waitFor(
    async () => {
      const s = await snapshot(page);
      return s.positionMs >= atLeastMs ? s : null;
    },
    { timeout, what: `position>=${atLeastMs}ms` },
  );
}

export async function waitTrackCount(page, atLeast, timeout = 30_000) {
  return waitFor(
    async () => {
      const t = await tracks(page);
      return t.length >= atLeast ? t : null;
    },
    { timeout, what: `>=${atLeast} library tracks` },
  );
}
