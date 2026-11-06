// session.mjs — the app lifecycle.
//
// Launch model: private Xvfb (never the user's display), private PipeWire
// daemon (never the user's audio session), fresh --user-data-dir (NEVER the
// real ~/.config/cadence — the user's own instance may be running and
// single-instance is keyed on userData).
//
// Two flavors:
//   dev      — repo Electron + apps/desktop (needs pnpm -r build + cargo build)
//   packaged — apps/desktop/release/linux-unpacked/cadence (needs dist:dir)
//
// Ready = the renderer is up AND window.cadence answers getSnapshot().
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, chromium } from "playwright-core";
import {
  REPO, electronBinary, packagedBinary, cleanEnv, waitFor, writeJson, readJson, sleep,
} from "./env.mjs";
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

/** Launch via playwright _electron (in-process control). Used by `run`. */
export async function launchManaged({ flavor = "dev", userData = null, runDir, pwMode = "private" } = {}) {
  const ud = userData ?? mkdtempSync(join(tmpdir(), "cadence-verify-ud-"));
  mkdirSync(ud, { recursive: true });
  const xvfb = await startXvfb();
  const pw = await new Pw({ mode: pwMode, logPath: join(runDir, "logs", "pipewire.log") }).start();
  const logStream = createWriteStream(join(runDir, "logs", "electron.log"), { flags: "a" });

  let app = null;
  try {
    if (pwMode === "session") pw.swapDefault();
    const bin = flavor === "packaged" ? packagedBinary() : electronBinary();
    if (!bin) throw new Error(`no electron binary for flavor ${flavor} (run builds first)`);
    const args = flavor === "packaged"
      ? baseArgs(ud)
      : [join(REPO, "apps", "desktop"), ...baseArgs(ud)];
    app = await _electron.launch({
      executablePath: bin,
      args,
      env: pw.env(cleanEnv({ DISPLAY: xvfb.display })),
      timeout: 45_000,
    });
    if (pwMode === "session") pw.restoreDefault();
    app.process().stderr?.pipe(logStream);
    app.process().stdout?.pipe(logStream);
    const page = await app.firstWindow();
    await waitReady(page);
    return finishLaunch({ flavor, app, page, xvfb, pw, ud, runDir, managed: true });
  } catch (e) {
    await teardownRaw({ app, xvfb, pw, managed: true });
    throw e;
  }
}

/** Spawn electron + fixed CDP port so later CLI calls can attach. `launch`. */
export async function launchInteractive({ flavor = "dev", userData = null, runDir, cdpPort = 9333, pwMode = "private" } = {}) {
  const ud = userData ?? mkdtempSync(join(tmpdir(), "cadence-verify-ud-"));
  mkdirSync(ud, { recursive: true });
  const xvfb = await startXvfb({ persistent: true });
  const pw = await new Pw({ mode: pwMode, logPath: join(runDir, "logs", "pipewire.log"), persistent: true }).start();
  // the process outlives this CLI call — send its output to a real file
  // descriptor, not a pipe that dies with us
  const logFd = openSync(join(runDir, "logs", "electron.log"), "a");

  let proc = null;
  try {
    if (pwMode === "session") pw.swapDefault();
    const bin = flavor === "packaged" ? packagedBinary() : electronBinary();
    if (!bin) throw new Error(`no electron binary for flavor ${flavor} (run builds first)`);
    const args = flavor === "packaged"
      ? baseArgs(ud, [`--remote-debugging-port=${cdpPort}`])
      : [join(REPO, "apps", "desktop"), ...baseArgs(ud, [`--remote-debugging-port=${cdpPort}`])];
    proc = spawn(bin, args, {
      env: pw.env(cleanEnv({ DISPLAY: xvfb.display })),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    closeSync(logFd);
    proc.unref();
    if (pwMode === "session") pw.restoreDefault();
    // connectOverCDP does not retry a refused connection — wait for the
    // DevTools endpoint to bind first
    await waitFor(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
          return r.ok;
        } catch { return null; }
      },
      { timeout: 30_000, every: 400, what: `CDP :${cdpPort}` },
    );
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 30_000 });
    const page = await waitFor(
      () => browser.contexts()[0]?.pages()[0] ?? null,
      { timeout: 30_000, what: "CDP page" },
    );
    await waitReady(page);
    return finishLaunch({
      flavor, app: null, page, xvfb, pw, ud, runDir,
      managed: false, proc, browser, cdpPort,
    });
  } catch (e) {
    if (proc) proc.kill("SIGKILL");
    await pw.stop();
    xvfb.stop();
    throw e;
  }
}

async function finishLaunch(o) {
  const meta = {
    flavor: o.flavor,
    pid: o.managed ? o.app.process().pid : o.proc.pid,
    display: o.xvfb.display,
    xvfbPid: o.xvfb.proc.pid,
    userData: o.ud,
    cdpPort: o.cdpPort ?? null,
    pw: { mode: o.pw.mode, runtimeDir: o.pw.runtimeDir, daemonPid: o.pw.daemon?.pid ?? null, smPid: o.pw.sm?.pid ?? null, tapModuleId: o.pw.tapModuleId, adopted: o.pw.tapAdopted },
    prevDefaultSink: o.pw.prevDefault,
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
 * private pw core (session mode: momentary default swap again so the new
 * stream lands on the tap). Mutates ctx.app/ctx.page.
 */
export async function relaunchManaged(ctx) {
  if (ctx.pw.mode === "session") ctx.pw.swapDefault();
  try {
    const bin = ctx.flavor === "packaged" ? packagedBinary() : electronBinary();
    const args = ctx.flavor === "packaged"
      ? baseArgs(ctx.ud)
      : [join(REPO, "apps", "desktop"), ...baseArgs(ctx.ud)];
    const logStream = createWriteStream(join(ctx.runDir, "logs", "electron.log"), { flags: "a" });
    const app = await _electron.launch({
      executablePath: bin,
      args,
      env: ctx.pw.env(cleanEnv({ DISPLAY: ctx.xvfb.display })),
      timeout: 45_000,
    });
    app.process().stderr?.pipe(logStream);
    app.process().stdout?.pipe(logStream);
    const page = await app.firstWindow();
    await waitReady(page);
    ctx.app = app;
    ctx.page = page;
    ctx.meta.pid = app.process().pid;
    writeJson(sessionFile(ctx.runDir), ctx.meta);
    ctx.ev?.step("launch", `relaunch pid=${ctx.meta.pid}`);
    return ctx;
  } finally {
    if (ctx.pw.mode === "session") ctx.pw.restoreDefault();
  }
}

export async function teardownRaw({ app, proc, browser, xvfb, pw, managed }) {
  if (managed && app) {
    try { await quitManaged(app); } catch { try { app.process().kill("SIGKILL"); } catch {} }
  } else {
    try { proc?.kill("SIGTERM"); } catch {}
    await sleep(800);
    try { proc?.kill("SIGKILL"); } catch {}
    try { await browser?.close(); } catch {}
  }
  try { await pw?.stop(); } catch {}
  try { xvfb?.stop(); } catch {}
}

/** Teardown a recorded session from a previous CLI call (stop/cleanup). */
export async function teardownRecorded(runDir) {
  const meta = readJson(sessionFile(runDir));
  if (!meta) throw new Error(`no session.json in ${runDir}`);
  try { process.kill(meta.pid, "SIGTERM"); } catch {}
  await sleep(1200);
  try { process.kill(meta.pid, "SIGKILL"); } catch {}
  try { process.kill(meta.xvfbPid, "SIGTERM"); } catch {}
  // pipewire re-forks on start — the recorded pid is often a dead parent.
  // The runtime dir is the stable signature of the whole private graph.
  if (meta.pw?.runtimeDir) {
    new Pw({ mode: "private", runtimeDir: meta.pw.runtimeDir }).killByRuntimeDir();
  }
  for (const pid of [meta.pw?.smPid, meta.pw?.daemonPid]) {
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
  if (meta.pw?.mode === "session" && !meta.pw?.adopted && !meta.pw?.runtimeDir) {
    // session-mode tap sink in the user's daemon: restore + unload
    const pw = new Pw({ mode: "session" });
    try { if (meta.prevDefaultSink) pw.runPw("pactl", ["set-default-sink", meta.prevDefaultSink]); } catch {}
    const r = pw.runPw("pactl", ["-f", "json", "list", "modules"]);
    try {
      for (const m of JSON.parse(r.out)) {
        if (String(m.argument ?? "").includes(`sink_name=cadence_verify`)) {
          pw.runPw("pactl", ["unload-module", String(m.index)]);
        }
      }
    } catch { /* fall through */ }
  }
  return meta;
}

/** Attach to an interactive session recorded in runDir. */
export async function attach(runDir) {
  const meta = readJson(sessionFile(runDir));
  if (!meta?.cdpPort) throw new Error(`no attachable session in ${runDir} (launch first)`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${meta.cdpPort}`, { timeout: 10_000 });
  const page = await waitFor(() => browser.contexts()[0]?.pages()[0] ?? null, {
    timeout: 10_000, what: "CDP page",
  });
  const pw = new Pw({
    mode: meta.pw?.mode ?? "session",
    runtimeDir: meta.pw?.runtimeDir ?? null,
  });
  return { meta, browser, page, pw };
}
