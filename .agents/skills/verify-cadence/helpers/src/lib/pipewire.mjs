// pipewire.mjs — audio graph isolation and capture.
//
// The ONLY supported mode is a PRIVATE PipeWire daemon for the run: own
// runtime dir, own socket, policy-only WirePlumber (no hardware monitors,
// no dbus). The app is launched with XDG_RUNTIME_DIR/PIPEWIRE_RUNTIME_DIR
// pointed at it plus an ALSA config whose default device is the pipewire
// plugin, so its cpal->ALSA->pipewire-alsa stream appears in our graph and
// ONLY our graph: nothing can reach the user's sinks, and the user's
// session is never re-routed. There is no session mode — loading a null
// sink into the user's daemon and swapping the real default (what session
// mode did) is exactly the behavior this harness exists to prevent, so the
// option fails closed before anything is spawned.
//
// One dedicated null sink (cadence_verify) lives in the private core. The
// harness pw-links the app's stream into it and records the sink's monitor
// ports — the same shared-tap method the issue-1 harness proved.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, createWriteStream, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run, sleep, waitFor } from "./env.mjs";
import { harnessEnv, isPrivateAudioProc, procEnv, descendantPids } from "./isolation.mjs";

export const TAP_NAME = "cadence_verify";
const CONF = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "pipewire-verify.conf");
const WP_CONF = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "wireplumber-verify.conf");

export class Pw {
  /**
   * @param {object} o
   * @param {"private"} o.mode      only "private" is supported
   * @param {string} [o.runtimeDir] adopt an existing private core (attach/stop)
   * @param {string} [o.logPath]    daemon log file
   */
  constructor({ mode = "private", runtimeDir = null, logPath = null, persistent = false, aborted = null }) {
    if (mode !== "private") {
      // fail closed BEFORE anything is spawned — never touch the user's
      // audio session, even when asked politely with a flag.
      throw new Error(
        `--pw ${mode} is not supported: only a private PipeWire core is allowed (session mode mutated the user's real audio session)`,
      );
    }
    this.mode = mode;
    this.runtimeDir = runtimeDir;
    this.persistent = persistent;
    this.daemon = null;
    this.sm = null;
    this.logPath = logPath;
    this.aborted = aborted; // optional predicate — abort mid-start, never spawn after it
  }

  /** Kill every private-core daemon process carrying this core's runtime
   * dir in its environment — pipewire re-forks, so the spawn pid is not
   * the survivor; the environ signature is. Matching is EXACT on the
   * NUL-separated environ entries and restricted to audio-daemon comms, so
   * an unrelated process can never be swept. */
  killByRuntimeDir() {
    if (!this.runtimeDir) return;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      const env = procEnv(Number(pid));
      if (!env) continue;
      const ours = env.PIPEWIRE_RUNTIME_DIR === this.runtimeDir
        || env.XDG_RUNTIME_DIR === this.runtimeDir;
      if (ours && isPrivateAudioProc(Number(pid))) {
        try { process.kill(Number(pid), "SIGTERM"); } catch {}
      }
    }
  }

  /** Env for harness pw-tools AND the spawned app's base: sanitized parent
   * env plus the private core's coordinates. With this set, every PipeWire
   * client (app, pw-cat, pactl) lands inside our core only. */
  env(extra = {}) {
    return harnessEnv({
      ...extra,
      XDG_RUNTIME_DIR: this.runtimeDir,
      PIPEWIRE_RUNTIME_DIR: this.runtimeDir,
      PIPEWIRE_REMOTE: "pipewire-0",
    });
  }

  runPw(cmd, args, opts = {}) {
    return run(cmd, args, { env: this.env(), timeout: 15_000, ...opts });
  }

  async start() {
    const chk = () => {
      if (this.aborted?.()) throw new Error("private PipeWire start aborted");
    };
    const waitOpts = { aborted: () => this.aborted?.() ?? false };
    chk();
    this.runtimeDir = mkdtempSync(join(tmpdir(), "cadence-pw-"));
    this.stateDir = mkdtempSync(join(tmpdir(), "cadence-wp-"));
    const log = this.logPath ? createWriteStream(this.logPath, { flags: "a" }) : null;
    this.daemon = spawn("pipewire", ["-c", CONF], {
      env: this.env(), stdio: ["ignore", "pipe", "pipe"], detached: this.persistent,
    });
    if (this.persistent) this.daemon.unref();
    if (log) { this.daemon.stdout.pipe(log); this.daemon.stderr.pipe(log); }
    else { this.daemon.stdout.resume(); this.daemon.stderr.resume(); }
    const sock = join(this.runtimeDir, "pipewire-0");
    await waitFor(() => existsSync(sock) || null, {
      timeout: 10_000, what: `private pipewire socket ${sock}`, ...waitOpts,
    });
    chk(); // an abort during the socket wait must not reach the SM spawn
    await waitFor(() => {
      const r = this.runPw("pw-dump", []);
      return r.code === 0 ? true : null;
    }, { timeout: 10_000, what: "private pipewire answering pw-dump", ...waitOpts });
    chk();
    // policy-only WirePlumber: session management (activation, port
    // configs, auto-link to the only endpoint) with NO hardware
    // monitors — it can never grab a real device into this graph.
    this.sm = spawn("wireplumber", ["-c", WP_CONF, "-p", "verify"], {
      env: {
        ...this.env(),
        XDG_STATE_HOME: this.stateDir,
        XDG_CONFIG_HOME: this.stateDir,
        XDG_CACHE_HOME: this.stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.persistent,
    });
    if (this.persistent) this.sm.unref();
    if (log) { this.sm.stdout.pipe(log); this.sm.stderr.pipe(log); }
    else { this.sm.stdout.resume(); this.sm.stderr.resume(); }
    // tap sink exists from daemon config; the SM activates it → ports.
    // WP's no-media-session probe makes first connect slow — be generous.
    await waitFor(() => (this.tapPorts()?.inPorts.length ?? 0) >= 1 || null, {
      timeout: 30_000, every: 250, what: `${TAP_NAME} playback ports`, ...waitOpts,
    });
    await waitFor(() => (this.tapPorts()?.monitorPorts.length ?? 0) >= 1 || null, {
      timeout: 15_000, every: 250, what: `${TAP_NAME} monitor ports`, ...waitOpts,
    });
    if (!this.sinkExists()) {
      throw new Error(`private core has no ${TAP_NAME} sink (bad pipewire-verify.conf?)`);
    }
    return this;
  }

  dump() {
    return JSON.parse(this.runPw("pw-dump", []).out || "[]");
  }

  nodes(pred = () => true) {
    return this.dump().filter(
      (o) => o.type === "PipeWire:Interface:Node" && pred(o.info?.props ?? {}, o.id),
    );
  }

  portsOf(nodeId, direction) {
    // direction lives on port info (not props): "input" | "output"
    const want = direction === "in" ? "input" : direction === "out" ? "output" : direction;
    return this.dump()
      .filter(
        (o) =>
          o.type === "PipeWire:Interface:Port" &&
          o.info?.props?.["node.id"] === nodeId &&
          o.info?.direction === want,
      )
      .map((o) => o.id);
  }

  /** Monitor (tap) ports of a node: output-direction port.monitor ports. */
  monitorPortsOf(nodeId) {
    return this.dump()
      .filter(
        (o) =>
          o.type === "PipeWire:Interface:Port" &&
          o.info?.props?.["node.id"] === nodeId &&
          o.info?.direction === "output" &&
          (o.info?.props?.["port.monitor"] === true ||
            String(o.info?.props?.["port.name"] ?? "").startsWith("monitor")),
      )
      .map((o) => o.id);
  }

  links() {
    const out = [];
    for (const o of this.dump()) {
      if (o.type !== "PipeWire:Interface:Link") continue;
      const p = o.info?.props ?? {};
      out.push({
        id: o.id,
        outPort: p["link.output.port"],
        inPort: p["link.input.port"],
        outNode: p["link.output.node"],
        inNode: p["link.input.node"],
      });
    }
    return out;
  }

  link(outPort, inPort) {
    return this.runPw("pw-link", [String(outPort), String(inPort)]).code === 0;
  }

  unlink(outPort, inPort) {
    return this.runPw("pw-link", ["-d", String(outPort), String(inPort)]).code === 0;
  }

  sinkExists(name = TAP_NAME) {
    return this.nodes((p) => p["node.name"] === name).length > 0;
  }

  /** The tap sink node + its playback (in) and monitor (out) ports. */
  tapPorts() {
    const node = this.nodes((p) => p["node.name"] === TAP_NAME)[0];
    if (!node) return null;
    return {
      nodeId: node.id,
      inPorts: this.portsOf(node.id, "in"),
      monitorPorts: this.monitorPortsOf(node.id),
    };
  }

  audioServicePid(rootPid) {
    for (const pid of descendantPids(rootPid)) {
      try {
        if (readFileSync(`/proc/${pid}/comm`, "utf8").includes("cadence-audio")) return pid;
      } catch { /* gone */ }
    }
    return null;
  }

  streamNodesForPids(pids, mediaClass = "Stream/Output/Audio") {
    const clientIds = new Set(
      this.dump()
        .filter(
          (o) =>
            o.type === "PipeWire:Interface:Client" &&
            pids.has(Number(o.info?.props?.["application.process.id"])),
        )
        .map((o) => o.id),
    );
    return this.nodes((p) => clientIds.has(Number(p["client.id"])) && p["media.class"] === mediaClass);
  }

  /**
   * Wait for the app's output stream, then wire it to the tap sink.
   * Returns {nodeId, audioPid, ports}.
   */
  async waitForAppStream(rootPid, { timeout = 20_000 } = {}) {
    const audioPid = await waitFor(() => this.audioServicePid(rootPid), {
      timeout, what: "cadence-audio child process",
    });
    const pids = descendantPids(rootPid);
    pids.add(audioPid);
    const node = await waitFor(
      () => this.streamNodesForPids(pids)[0] ?? null,
      { timeout, what: "app Stream/Output/Audio node" },
    );
    return { nodeId: node.id, props: node.info.props, ports: this.portsOf(node.id, "output"), audioPid };
  }

  /** Link every app output port to a tap input port (idempotent). */
  wireToTap(nodeId) {
    const tap = this.tapPorts();
    if (!tap) return 0;
    const existing = new Set(this.links().map((l) => `${l.outPort}->${l.inPort}`));
    let n = 0;
    const outs = this.portsOf(nodeId, "output");
    for (let k = 0; k < Math.max(outs.length, tap.inPorts.length); k++) {
      const o = outs[k % outs.length];
      const i = tap.inPorts[k % tap.inPorts.length];
      if (o != null && i != null && !existing.has(`${o}->${i}`) && this.link(o, i)) n++;
    }
    return n;
  }

  /** Which sinks the app's stream is linked to (node names). */
  appStreamSinks(nodeId) {
    const outPorts = new Set(this.portsOf(nodeId, "output"));
    const sinkIds = new Set(this.nodes((p) => p["media.class"] === "Audio/Sink").map((o) => o.id));
    const hit = new Set();
    for (const l of this.links()) {
      if (outPorts.has(l.outPort) && sinkIds.has(l.inNode)) hit.add(l.inNode);
    }
    const all = this.nodes(() => true);
    return [...hit].map((id) => ({
      id, name: all.find((o) => o.id === id)?.info?.props?.["node.name"] ?? String(id),
    }));
  }

  /**
   * Record what the tap sink's MONITOR ports receive — nothing else. There
   * is deliberately no fallback onto the app's own output ports: a capture
   * that bypasses the sink cannot prove audio reached the audio system.
   * Returns {stop(), path, pid, t0} where t0 (ms epoch) is anchored to the
   * first bytes the recorder wrote — capture time 0 for the analyzer.
   */
  async startMonitorCapture(outPath) {
    const proc = spawn("pw-cat", [
      "-r", "--raw", "--target", "0",
      "--rate", "48000", "--channels", "2", "--format", "f32", outPath,
    ], { env: this.env(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });

    const deadline = Date.now() + 10_000;
    let linked = false;
    while (Date.now() < deadline && !linked) {
      const rec = this.streamNodesForPids(new Set([proc.pid]), "Stream/Input/Audio")[0];
      if (rec) {
        const inPorts = this.portsOf(rec.id, "input");
        const existing = new Set(this.links().map((l) => `${l.outPort}->${l.inPort}`));
        const sources = this.tapPorts()?.monitorPorts ?? [];
        let n = 0;
        for (let k = 0; k < Math.max(sources.length, inPorts.length); k++) {
          const o = sources[k % sources.length];
          const i = inPorts[k % inPorts.length];
          if (o != null && i != null && !existing.has(`${o}->${i}`) && this.link(o, i)) n++;
        }
        linked = n >= 2 || (sources.length === 1 && n === 1);
      }
      await sleep(120);
    }
    if (!linked) {
      proc.kill("SIGKILL");
      throw new Error(`pw-cat recorder never linked to ${TAP_NAME} monitor ports: ${stderr.trim()}`);
    }
    // Anchor the capture clock to the first recorded samples, not to the
    // link moment — before then the file holds nothing meaningful.
    const t0 = await waitFor(
      () => (existsSync(outPath) && statSync(outPath).size > 0 ? Date.now() : null),
      { timeout: 5_000, every: 50, what: "first captured bytes" },
    ).catch(() => Date.now());
    return {
      path: outPath,
      pid: proc.pid,
      t0,
      proc,
      async stop() {
        proc.kill("SIGINT");
        const deadline = Date.now() + 5_000;
        while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      },
    };
  }

  /** Everything this scope created goes away. Evidence never does.
   * Awaits actual exits — teardown must not finish while a daemon is
   * still shutting down (a lingerer looks exactly like a leak). */
  async stop() {
    const targets = [this.sm, this.daemon].filter(Boolean);
    try { this.sm?.kill("SIGTERM"); } catch {}
    try { this.daemon?.kill("SIGTERM"); } catch {}
    // pipewire re-forks — the spawn pid is often a dead parent; the
    // runtime dir marks the real survivors (exact env match, daemons only)
    this.killByRuntimeDir();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && targets.some((p) => p.exitCode === null)) await sleep(50);
    try { this.sm?.kill("SIGKILL"); } catch {}
    try { this.daemon?.kill("SIGKILL"); } catch {}
    this.killByRuntimeDir();
    const kdeadline = Date.now() + 1_000;
    while (Date.now() < kdeadline && targets.some((p) => p.exitCode === null)) await sleep(50);
  }

  /** Temp dirs this scope owns — safe to delete once the core is down. */
  ownedTempDirs() {
    return [this.runtimeDir, this.stateDir].filter(Boolean);
  }

  /** Remove the private runtime/state dirs after a normal stop. */
  removeOwnedDirs() {
    for (const d of this.ownedTempDirs()) {
      // only ever remove dirs we created under the OS temp dir
      if (d.startsWith(tmpdir()) && /cadence-(pw|wp)-/.test(d)) {
        try { rmSync(d, { recursive: true, force: true }); } catch {}
      }
    }
  }
}
