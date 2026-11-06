// session.mjs — the app lifecycle.
//
// Launch model: private Xvfb (never the user's display), private PipeWire
// core (never the user's audio session), harness-owned --user-data-dir
// only (NEVER the real ~/.config/cadence — the user's own instance may be
// running and single-instance is keyed on userData), sanitized env so no
// inherited route can steer the app at a real device or stale code.
//
// Two flavors:
//   dev      — repo Electron + apps/desktop (needs pnpm -r build + cargo build)
//   packaged — apps/desktop/release/linux-unpacked/cadence (needs dist:dir)
//
// Ready = the renderer is up AND window.cadence answers getSnapshot().
// Every launch allocates a CDP port (ephemeral unless --cdp asks for one);
// the endpoint is proven to belong to the recorded app pid/profile/private
// display before it is trusted — a fixed port could otherwise be an
// unrelated running Chromium.
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, openSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { _electron, chromium } from "playwright-core";
import {
  REPO, electronBinary, packagedBinary, waitFor, writeJson, readJson, sleep,
} from "./env.mjs";
import {
  prepareUserData, requireAudioBinary, sanitizedAppEnv, writePrivateAsound,
  freePort, cdpOccupied, verifyCdpEndpoint, verifyRecordedProcess,
  procAlive, procStartTime, procIds, procComm, descendantPids, UD_MARKER,
} from "./isolation.mjs";
import { startXvfb } from "./xvfb.mjs";
import { Pw } from "./pipewire.mjs";

export function sessionFile(runDir) {
  return join(runDir, "session.json");
}

function baseArgs(userData, extra = []) {
  return [
    `--user-data-dir=${userData}`,
    "--disable-gpu",
    "--ozone-platform=x11",
    "--no-sandbox",
    "--disable-session-crashed-bubble",
    ...extra,
  ];
}

/** Wait for the renderer's bridge to be live; returns when usable. */
export async function waitReady(page, timeout = 20_000) {
  await waitFor(
    async () => (await page.evaluate(() => typeof window.cadence).catch(() => "missing")) === "object",
    { timeout, every: 300, what: "window.cadence bridge" },
  );
  await waitFor(
    async () => {
      const s = await page.evaluate(() => window.cadence.getSnapshot()).catch(() => null);
      return s && typeof s.status === "string" ? s : null;
    },
    { timeout, every: 300, what: "coordinator snapshot over IPC" },
  );
}

/** Everything a launch acquired, newest-first for teardown. A partial
 * failure must still clean up what came up — resources are recorded as
 * they are acquired, never left for "the caller's catch". */
function tracked() {
  return { xvfb: null, pw: null, app: null, proc: null, browser: null, ud: null, recorders: [] };
}

/** In-flight launch resource records. Registered while a launch is in
 * progress so a SIGTERM/SIGINT arriving MID-launch (before ctx exists)
 * can still reap the Xvfb/private core/profile already acquired. */
export const activeLaunches = new Set();

/** Set by teardownActiveLaunches — every pending acquisition step checks
 * it so signal cleanup cannot race a LATER spawn (e.g. teardown running
 * while a launch's next await resolves into another spawn call). */
let launchAborted = false;

export class LaunchAborted extends Error {
  constructor() { super("launch aborted by signal teardown"); this.name = "LaunchAborted"; }
}

function checkAborted() {
  if (launchAborted) throw new LaunchAborted();
}

/** Teardown for resources of launches still in progress. The CLI's signal
 * handler calls this before exiting; safe to call with nothing in flight.
 * After releasing every tracked record it sweeps OUR OWN child tree for
 * the app binary — the one window spawn-time tracking cannot cover:
 * playwright's _electron.launch resolves only AFTER spawning. */
export async function teardownActiveLaunches() {
  launchAborted = true; // pending launch steps bail at the next checkpoint
  const rs = [...activeLaunches];
  for (const r of rs) {
    try { await releaseTracked(r); } catch {}
    activeLaunches.delete(r);
  }
  // backstop: any cadence/electron child of THIS process not yet registered
  for (const pid of descendantPids(process.pid)) {
    if (pid === process.pid) continue;
    const comm = procComm(pid);
    if (comm && /^(electron|cadence|cadence-audio|Xvfb|pipewire|wireplumber|pw-cat)$/.test(comm)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  // then WAIT (bounded) for each in-flight launch to settle — a launch may
  // be inside playwright's spawn-before-resolve window; its own catch is
  // what kills that late-arriving app handle, so give it time to run
  const deadline = Date.now() + 5_000;
  for (const r of rs) {
    while (r.settled === false && Date.now() < deadline) await sleep(50);
  }
}

/** Remove a harness-owned profile dir (marker present). Never called on
 * paths without the marker. */
function removeOwnedUserData(ud) {
  if (ud && existsSync(join(ud, UD_MARKER))) {
    try { rmSync(ud, { recursive: true, force: true }); } catch {}
  }
}

async function releaseTracked(r, { removeOwnedDirs = true } = {}) {
  for (const rec of r.recorders) { try { await rec.stop(); } catch {} }
  if (r.app) {
    try { await quitManaged(r.app); } catch { try { r.app.process().kill("SIGKILL"); } catch {} }
  }
  if (r.proc) {
    // detached spawn: the child leads its own process group — SIGTERM the
    // group so renderers/utility/audio children cannot be orphaned.
    try {
      const ids = procIds(r.proc.pid);
      if (ids?.pgid === r.proc.pid) process.kill(-r.proc.pid, "SIGTERM");
      else r.proc.kill("SIGTERM");
    } catch { try { r.proc.kill("SIGTERM"); } catch {} }
    const deadline = Date.now() + 3_000;
    while (r.proc.exitCode === null && procAlive(r.proc.pid) && Date.now() < deadline) await sleep(50);
    try { r.proc.kill("SIGKILL"); } catch {}
    const kdeadline = Date.now() + 1_000;
    while (r.proc.exitCode === null && procAlive(r.proc.pid) && Date.now() < kdeadline) await sleep(50);
  }
  try { await r.browser?.close(); } catch {}
  try { await r.pw?.stop(); } catch {}
  // xvfb.stop() is async — AWAIT it: a teardown that exits while the X
  // server is still dying looks exactly like a leaked Xvfb
  try { await r.xvfb?.stop(); } catch {}
  if (removeOwnedDirs) {
    try { r.pw?.removeOwnedDirs(); } catch {}
    // the owned profile is as much temp state as the graph dirs — a
    // failed or finished launch leaves nothing behind but evidence
    removeOwnedUserData(r.ud);
  }
}

/** A failure must leave a diagnosable electron.log even when the process
 * never got far enough to pipe stderr (managed launches only see stderr
 * after playwright's handshake resolves). */
function logLaunchFailure(runDir, e, context = {}) {
  try {
    appendFileSync(
      join(runDir, "logs", "electron.log"),
      `\n=== cadence-verify launch failure ${new Date().toISOString()} ===\n` +
        `${e?.stack ?? e}\n` +
        `context: ${JSON.stringify(context, null, 2)}\n`,
    );
  } catch { /* evidence dir gone — nothing to write to */ }
}

/**
 * Shared launch prep — fail closed BEFORE any spawn:
 *  - profile: fresh harness-owned --user-data (never a real profile)
 *  - audio binary: the repo build, pinned via CADENCE_AUDIO_BIN
 *  - private ALSA default: pipewire plugin → the private core
 *  - CDP port: free (ephemeral by default; explicit --cdp must be unused)
 * Returns {ud, asoundPath, cdpPort, audioBin}.
 */
async function prepareLaunch({ userData, runDir, cdpPort }) {
  const audioBin = requireAudioBinary();
  // port sanity first — refuse before creating any owned state
  if (cdpPort == null) {
    cdpPort = await freePort();
  } else if (await cdpOccupied(cdpPort)) {
    throw new Error(
      `CDP port ${cdpPort} is already in use — refusing to launch: a fixed port could ` +
        `silently connect to an unrelated browser. Pass --cdp <free port> or omit for ephemeral.`,
    );
  }
  const ud = prepareUserData(userData);
  const asoundPath = writePrivateAsound(join(runDir, "asound.conf"));
  return { ud, asoundPath, cdpPort, audioBin };
}

function appEnvFor({ pw, display, asoundPath, audioBin }) {
  return sanitizedAppEnv({
    extra: {
      DISPLAY: display,
      XDG_RUNTIME_DIR: pw.runtimeDir,
      PIPEWIRE_RUNTIME_DIR: pw.runtimeDir,
      PIPEWIRE_REMOTE: "pipewire-0",
    },
    audioBin,
    asoundPath,
  });
}

function appArgs({ flavor, ud, cdpPort }) {
  const args = baseArgs(ud, [`--remote-debugging-port=${cdpPort}`]);
  return flavor === "packaged" ? args : [join(REPO, "apps", "desktop"), ...args];
}

/** Launch via playwright _electron (in-process control). Used by `run`. */
export async function launchManaged({ flavor = "dev", userData = null, runDir } = {}) {
  const { ud, asoundPath, cdpPort, audioBin } = await prepareLaunch({
    userData, runDir, cdpPort: null,
  });
  const r = tracked();
  r.ud = ud;
  r.settled = false; // flipped in finally — signal teardown waits for it
  activeLaunches.add(r); // mid-launch SIGTERM can reap these too
  const logStream = createWriteStream(join(runDir, "logs", "electron.log"), { flags: "a" });
  try {
    r.xvfb = await startXvfb({ onProc: (h) => { r.xvfb = h; }, aborted: () => launchAborted });
    checkAborted();
    r.pw = new Pw({
      mode: "private", logPath: join(runDir, "logs", "pipewire.log"),
      aborted: () => launchAborted,
    });
    // assigned BEFORE start() resolves — a rejection still leaves the
    // half-up daemon reachable by releaseTracked
    await r.pw.start();
    checkAborted();
    const bin = flavor === "packaged" ? packagedBinary() : electronBinary();
    if (!bin) throw new Error(`no electron binary for flavor ${flavor} (run builds first)`);
    r.app = await _electron.launch({
      executablePath: bin,
      args: appArgs({ flavor, ud, cdpPort }),
      env: appEnvFor({ pw: r.pw, display: r.xvfb.display, asoundPath, audioBin }),
      timeout: 45_000,
    });
    // abort check AFTER registration — teardown's child sweep covers the
    // spawn-to-resolution window, this covers everything after
    checkAborted();
    r.app.process().stderr?.pipe(logStream);
    r.app.process().stdout?.pipe(logStream);
    const page = await r.app.firstWindow();
    await waitReady(page);
    checkAborted();
    // the CDP endpoint must belong to this app — not a pre-existing browser
    const cdp = await verifyCdpEndpoint(cdpPort, r.app.process().pid);
    if (!cdp.ok) {
      throw new Error(`CDP endpoint on :${cdpPort} failed ownership check: ${cdp.reasons.join("; ")}`);
    }
    activeLaunches.delete(r);
    return finishLaunch({
      flavor, app: r.app, page, xvfb: r.xvfb, pw: r.pw, ud, runDir,
      managed: true, cdpPort, tracked: r,
    });
  } catch (e) {
    logLaunchFailure(runDir, e, { flavor, ud, cdpPort });
    activeLaunches.delete(r);
    await releaseTracked(r);
    throw e;
  } finally {
    r.settled = true;
  }
}

/** Spawn electron + CDP port so later CLI calls can attach. `launch`. */
export async function launchInteractive({ flavor = "dev", userData = null, runDir, cdpPort = null } = {}) {
  const prep = await prepareLaunch({ userData, runDir, cdpPort });
  const { ud, asoundPath, audioBin } = prep;
  cdpPort = prep.cdpPort;
  const r = tracked();
  r.ud = ud;
  r.settled = false;
  activeLaunches.add(r);
  // the process outlives this CLI call — send its output to a real file
  // descriptor, not a pipe that dies with us
  const logFd = openSync(join(runDir, "logs", "electron.log"), "a");
  try {
    r.xvfb = await startXvfb({ persistent: true, onProc: (h) => { r.xvfb = h; }, aborted: () => launchAborted });
    checkAborted();
    r.pw = new Pw({
      mode: "private", logPath: join(runDir, "logs", "pipewire.log"), persistent: true,
      aborted: () => launchAborted,
    });
    await r.pw.start();
    checkAborted();
    const bin = flavor === "packaged" ? packagedBinary() : electronBinary();
    if (!bin) throw new Error(`no electron binary for flavor ${flavor} (run builds first)`);
    r.proc = spawn(bin, appArgs({ flavor, ud, cdpPort }), {
      env: appEnvFor({ pw: r.pw, display: r.xvfb.display, asoundPath, audioBin }),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    closeSync(logFd);
    r.proc.unref();
    // connectOverCDP does not retry a refused connection — wait for the
    // DevTools endpoint to bind first, then prove it is OUR app before
    // trusting it (an unrelated Chromium on the port must never attach)
    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
          return res.ok;
        } catch { return null; }
      },
      { timeout: 30_000, every: 400, what: `CDP :${cdpPort}` },
    );
    const cdp = await verifyCdpEndpoint(cdpPort, r.proc.pid);
    if (!cdp.ok) {
      throw new Error(`CDP endpoint on :${cdpPort} failed ownership check: ${cdp.reasons.join("; ")}`);
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 30_000 });
    r.browser = browser;
    const page = await waitFor(
      () => browser.contexts()[0]?.pages()[0] ?? null,
      { timeout: 30_000, what: "CDP page" },
    );
    await waitReady(page);
    checkAborted();
    activeLaunches.delete(r);
    return finishLaunch({
      flavor, app: null, page, xvfb: r.xvfb, pw: r.pw, ud, runDir,
      managed: false, proc: r.proc, browser, cdpPort, tracked: r,
    });
  } catch (e) {
    logLaunchFailure(runDir, e, { flavor, ud, cdpPort });
    activeLaunches.delete(r);
    try { closeSync(logFd); } catch {}
    await releaseTracked(r);
    throw e;
  } finally {
    r.settled = true;
  }
}

function finishLaunch(o) {
  const pid = o.managed ? o.app.process().pid : o.proc.pid;
  const meta = {
    flavor: o.flavor,
    pid,
    pidStartTime: procStartTime(pid),
    display: o.xvfb.display,
    xvfbPid: o.xvfb.proc.pid,
    xvfbPidStartTime: procStartTime(o.xvfb.proc.pid),
    userData: o.ud,
    cdpPort: o.cdpPort ?? null,
    pw: {
      mode: o.pw.mode,
      runtimeDir: o.pw.runtimeDir,
      stateDir: o.pw.stateDir ?? null,
      daemonPid: o.pw.daemon?.pid ?? null,
      daemonStartTime: o.pw.daemon ? procStartTime(o.pw.daemon.pid) : null,
      smPid: o.pw.sm?.pid ?? null,
      smStartTime: o.pw.sm ? procStartTime(o.pw.sm.pid) : null,
    },
    runDir: o.runDir,
    managed: o.managed,
    startedAt: new Date().toISOString(),
  };
  writeJson(sessionFile(o.runDir), meta);
  return { ...o, meta };
}

/** Graceful in-process quit (managed sessions): triggers 'will-quit' so the
 * coordinator persists queue+position — the restart flow relies on this.
 * Windows are destroyed first: on main, win.on('close') preventDefaults
 * unless the tray Quit path set its `quitting` flag, which would trap a
 * programmatic app.quit() forever (a real defect — see SKILL.md).
 * Returns "graceful" when the process exited on its own, "killed" when
 * the fallback SIGKILL fired. */
export async function quitManaged(app) {
  const how = { mode: "graceful" };
  await app.evaluate(({ app, BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    app.quit();
  }).catch(() => {}); // the evaluate context dies with the app — fine
  const exited = await waitFor(
    () => {
      try { return app.process().exitCode !== null || null; } catch { return true; }
    },
    { timeout: 10_000, every: 150, what: "electron exit" },
  ).catch(() => null);
  if (exited === null) {
    how.mode = "killed";
    try { app.process().kill("SIGKILL"); } catch {}
  }
  return how.mode;
}

/**
 * Relaunch a managed session after quitManaged: same userData, display and
 * private pw core. ctx.app is registered IMMEDIATELY after launch — before
 * readiness — so a readiness failure still lets teardown kill the new app.
 * Mutates ctx.app/ctx.page/meta.
 */
export async function relaunchManaged(ctx) {
  const bin = ctx.flavor === "packaged" ? packagedBinary() : electronBinary();
  const args = ctx.flavor === "packaged"
    ? baseArgs(ctx.ud, [`--remote-debugging-port=${ctx.meta.cdpPort}`])
    : [join(REPO, "apps", "desktop"), ...baseArgs(ctx.ud, [`--remote-debugging-port=${ctx.meta.cdpPort}`])];
  const logStream = createWriteStream(join(ctx.runDir, "logs", "electron.log"), { flags: "a" });
  const app = await _electron.launch({
    executablePath: bin,
    args,
    env: appEnvFor({
      pw: ctx.pw, display: ctx.xvfb.display,
      asoundPath: join(ctx.runDir, "asound.conf"), audioBin: requireAudioBinary(),
    }),
    timeout: 45_000,
  });
  ctx.app = app; // tracked from this moment even if readiness fails
  app.process().stderr?.pipe(logStream);
  app.process().stdout?.pipe(logStream);
  try {
    const page = await app.firstWindow();
    await waitReady(page);
    ctx.page = page;
    ctx.meta.pid = app.process().pid;
    ctx.meta.pidStartTime = procStartTime(ctx.meta.pid);
    writeJson(sessionFile(ctx.runDir), ctx.meta);
    ctx.ev?.step("launch", `relaunch pid=${ctx.meta.pid}`);
    return ctx;
  } catch (e) {
    logLaunchFailure(ctx.runDir, e, { relaunch: true, pid: app.process()?.pid });
    throw e;
  }
}

export async function teardownRaw(ctx) {
  const r = ctx.tracked ?? { recorders: [] };
  r.app = ctx.app ?? r.app;
  r.proc = ctx.proc ?? r.proc;
  r.browser = ctx.browser ?? r.browser;
  r.pw = ctx.pw ?? r.pw;
  r.xvfb = ctx.xvfb ?? r.xvfb;
  r.ud = ctx.ud ?? r.ud;
  await releaseTracked(r);
}

/** Kill a recorded pid ONLY when it is still the exact process the session
 * recorded (alive + same starttime + expected cmdline/env). A reused pid
 * is left alone. Returns a short reason string for the transcript. */
function killRecorded(meta, pid, startTime, { matchArgv = null, matchDisplay = false } = {}) {
  if (!pid || !procAlive(pid)) return "already dead";
  if (!startTime) return `skipped kill: no recorded starttime for pid ${pid} — cannot prove identity`;
  if (procStartTime(pid) !== startTime) {
    return `skipped kill: starttime mismatch — pid ${pid} was reused`;
  }
  const v = verifyRecordedProcess(pid, {
    pidStartTime: startTime,
    userData: matchArgv ? meta.userData : null,
    cdpPort: matchArgv ? meta.cdpPort : null,
    display: matchDisplay ? meta.display : null,
  });
  if (!v.ok) return `skipped kill: ${v.reasons.join("; ")}`;
  try {
    const ids = procIds(pid);
    if (ids?.pgid === pid) process.kill(-pid, "SIGTERM"); // detached group leader
    else process.kill(pid, "SIGTERM");
  } catch { return "kill failed"; }
  return "terminated";
}

/** Teardown a recorded session from a previous CLI call (stop/cleanup). */
export async function teardownRecorded(runDir) {
  const meta = readJson(sessionFile(runDir));
  if (!meta) throw new Error(`no session.json in ${runDir}`);
  if (meta.stoppedAt) return meta; // already torn down — pids may be reused
  const notes = [];

  const appStop = killRecorded(meta, meta.pid, meta.pidStartTime, { matchArgv: true, matchDisplay: true });
  notes.push(`app pid ${meta.pid}: ${appStop}`);
  await sleep(1200);
  if (appStop === "terminated" && verifyRecordedProcess(meta.pid, meta).ok) {
    try {
      const ids = procIds(meta.pid);
      if (ids?.pgid === meta.pid) process.kill(-meta.pid, "SIGKILL");
      else process.kill(meta.pid, "SIGKILL");
    } catch {}
  }
  notes.push(`xvfb pid ${meta.xvfbPid}: ${killRecorded(meta, meta.xvfbPid, meta.xvfbPidStartTime)}`);

  // pipewire re-forks on start — the recorded pid is often a dead parent.
  // The runtime dir is the stable signature of the whole private graph;
  // killByRuntimeDir matches exact NUL env entries + audio-daemon comms.
  if (meta.pw?.runtimeDir) {
    const pw = new Pw({ mode: "private", runtimeDir: meta.pw.runtimeDir });
    pw.killByRuntimeDir();
    pw.stateDir = meta.pw.stateDir ?? null;
    pw.removeOwnedDirs();
  }
  // there is deliberately NO cleanup path that touches the user's real
  // PipeWire/Pulse session — even for metadata written by older harness
  // versions. A stale cadence_verify sink in the user session is the
  // user's to remove; this tool never sends pactl to a real daemon.

  // owned temp dirs go away after a normal stop; evidence under runDir never does
  removeOwnedUserData(meta.userData);

  meta.stoppedAt = new Date().toISOString();
  meta.teardownNotes = notes;
  writeJson(sessionFile(runDir), meta);
  return meta;
}

/**
 * Attach to an interactive session recorded in runDir. The endpoint must
 * still belong to the recorded app: pid alive with the same starttime,
 * cmdline carrying this profile + CDP port, environ on the recorded private
 * display, and the socket owner inside that pid's tree. A stale or foreign
 * endpoint is refused — we never attach to an arbitrary browser.
 */
export async function attach(runDir) {
  const meta = readJson(sessionFile(runDir));
  if (!meta?.cdpPort) throw new Error(`no attachable session in ${runDir} (launch first)`);
  if (meta.stoppedAt) throw new Error(`session in ${runDir} was stopped at ${meta.stoppedAt}`);
  const v = verifyRecordedProcess(meta.pid, meta);
  if (!v.ok) {
    throw new Error(`recorded session no longer owns :${meta.cdpPort}: ${v.reasons.join("; ")}`);
  }
  const cdp = await verifyCdpEndpoint(meta.cdpPort, meta.pid);
  if (!cdp.ok) {
    throw new Error(`CDP :${meta.cdpPort} rejected: ${cdp.reasons.join("; ")}`);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${meta.cdpPort}`, { timeout: 10_000 });
  const page = await waitFor(() => browser.contexts()[0]?.pages()[0] ?? null, {
    timeout: 10_000, what: "CDP page",
  });
  const pw = new Pw({
    mode: "private",
    runtimeDir: meta.pw?.runtimeDir ?? null,
  });
  if (meta.pw?.stateDir) pw.stateDir = meta.pw.stateDir;
  return { meta, browser, page, pw };
}
