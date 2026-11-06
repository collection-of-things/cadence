// pipewire.mjs — audio graph isolation and capture.
//
// Default mode: a PRIVATE PipeWire daemon for the run (own runtime dir,
// own socket, no session manager). The app is launched with
// XDG_RUNTIME_DIR/PIPEWIRE_RUNTIME_DIR pointed at it, so its cpal->ALSA->
// pipewire-alsa stream appears in our graph and ONLY our graph: nothing can
// reach the user's sinks, and the user's session is never re-routed —
// stronger isolation than the issue-1 harness needed, since real desktop
// audio may be live. We create one dedicated null sink (cadence_verify) in
// the private core, pw-link the app's stream into it, and record the sink's
// monitor ports — exactly the shared-tap method device_null_test.py proved.
//
// `session` mode remains as a fallback (--pw session): dedicated null sink
// in the user's PipeWire via pactl, momentary default swap at stream-creation
// boundaries, monitor capture, surgical restore. It exists because private
// mode needs a working standalone `pipewire` daemon.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run, sleep, waitFor } from "./env.mjs";

export const TAP_NAME = "cadence_verify";
const CONF = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "pipewire-verify.conf");
const WP_CONF = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "wireplumber-verify.conf");

export class Pw {
  /**
   * @param {object} o
   * @param {"private"|"session"} o.mode
   * @param {string} [o.runtimeDir]  private daemon runtime dir
   * @param {string} [o.logPath]     daemon log file
   */
  constructor({ mode, runtimeDir = null, logPath = null, persistent = false }) {
    this.mode = mode;
    this.runtimeDir = runtimeDir;
    this.persistent = persistent;
    this.daemon = null;
    this.logPath = logPath;
    this.prevDefault = null;
    this.tapModuleId = null;
    this.tapAdopted = false;
  }

  /** Kill every process that still carries this private core's runtime
   * dir in its environment — pipewire re-forks, so the spawn pid is not
   * the survivor; the environ signature is. */
  killByRuntimeDir() {
    if (!this.runtimeDir) return;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const env = readFileSync(`/proc/${pid}/environ`);
        if (env.includes(this.runtimeDir)) {
          try { process.kill(Number(pid), "SIGTERM"); } catch {}
        }
      } catch {}
    }
  }

  env(extra = {}) {
    const env = this.mode === "private"
      ? {
          ...process.env, ...extra,
          XDG_RUNTIME_DIR: this.runtimeDir,
          PIPEWIRE_RUNTIME_DIR: this.runtimeDir,
          PIPEWIRE_REMOTE: "pipewire-0",
        }
      : { ...process.env, ...extra };
    // agent sessions may carry ELECTRON_RUN_AS_NODE — it makes the
    // electron binary run as plain node and kills app.getAppPath()
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  runPw(cmd, args, opts = {}) {
    return run(cmd, args, { env: this.env(), timeout: 15_000, ...opts });
  }

  async start() {
    if (this.mode === "private") {
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
        timeout: 10_000, what: `private pipewire socket ${sock}`,
      });
      await waitFor(() => {
        const r = this.runPw("pw-dump", []);
        return r.code === 0 ? true : null;
      }, { timeout: 10_000, what: "private pipewire answering pw-dump" });
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
        timeout: 30_000, every: 250, what: `${TAP_NAME} playback ports`,
      });
      await waitFor(() => (this.tapPorts()?.monitorPorts.length ?? 0) >= 1 || null, {
        timeout: 15_000, every: 250, what: `${TAP_NAME} monitor ports`,
      });
    }
    this.ensureTapSink();
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

  ensureTapSink() {
    if (this.mode === "private") {
      // the verify config creates the sink; just confirm it's there
      if (!this.sinkExists()) throw new Error(`private core has no ${TAP_NAME} sink (bad pipewire-verify.conf?)`);
      return;
    }
    if (this.sinkExists()) { this.tapAdopted = true; return; }
    const r = this.runPw("pactl", [
      "load-module", "module-null-sink",
      `sink_name=${TAP_NAME}`, "rate=48000", "channels=2", "format=float32le",
      "sink_properties=device.description=CadenceVerifyTap",
    ]);
    if (r.code !== 0) throw new Error(`load-module null-sink failed: ${r.err}`);
    this.tapModuleId = r.out.trim();
  }

  /** session mode: momentarily make the tap the default. Caller restores. */
  swapDefault() {
    this.prevDefault = this.runPw("pactl", ["get-default-sink"]).out;
    this.runPw("pactl", ["set-default-sink", TAP_NAME]);
  }

  restoreDefault() {
    if (this.prevDefault) this.runPw("pactl", ["set-default-sink", this.prevDefault]);
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

  /** All descendant pids of rootPid. */
  descendantPids(rootPid) {
    const childrenOf = new Map();
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[1]);
        if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
        childrenOf.get(ppid).push(Number(d));
      } catch { /* gone */ }
    }
    const out = new Set([rootPid]);
    const stack = [rootPid];
    while (stack.length) {
      const p = stack.pop();
      for (const c of childrenOf.get(p) ?? []) {
        if (!out.has(c)) { out.add(c); stack.push(c); }
      }
    }
    return out;
  }

  audioServicePid(rootPid) {
    for (const pid of this.descendantPids(rootPid)) {
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
   * Returns {nodeId, audioPid, ports, linked}.
   */
  async waitForAppStream(rootPid, { timeout = 20_000 } = {}) {
    const audioPid = await waitFor(() => this.audioServicePid(rootPid), {
      timeout, what: "cadence-audio child process",
    });
    const pids = this.descendantPids(rootPid);
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

  /** session mode fallback: move the app's sink-input onto the tap. */
  moveAppSinkInput(audioPid) {
    const r = this.runPw("pactl", ["-f", "json", "list", "sink-inputs"]);
    try {
      for (const si of JSON.parse(r.out)) {
        if (Number(si.properties?.["application.process.id"]) === audioPid) {
          return this.runPw("pactl", ["move-sink-input", String(si.index), TAP_NAME]).code === 0;
        }
      }
    } catch { /* fall through */ }
    return false;
  }

  /**
   * Record what the tap sink receives: pw-cat recorder in the same core,
   * linked to the sink's monitor ports (fallback: tap the app's output
   * ports directly). Returns {stop(), path, pid}.
   */
  async startMonitorCapture(outPath, appNodeId = null) {
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
        // preferred sources: sink monitor ports, else the app's own outputs
        let sources = this.tapPorts()?.monitorPorts ?? [];
        if ((!sources.length || appNodeId) && appNodeId) {
          const extra = this.portsOf(appNodeId, "output");
          if (!sources.length) sources = extra;
        }
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
      throw new Error(`pw-cat recorder never linked: ${stderr.trim()}`);
    }
    return {
      path: outPath,
      pid: proc.pid,
      async stop() {
        proc.kill("SIGINT");
        const deadline = Date.now() + 5_000;
        while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      },
    };
  }

  /** Everything this scope created goes away. Evidence never does. */
  async stop() {
    if (this.mode === "session") {
      this.restoreDefault();
      if (!this.tapAdopted) {
        let id = this.tapModuleId;
        if (id == null || id === "") {
          const r = this.runPw("pactl", ["-f", "json", "list", "modules"]);
          try {
            for (const m of JSON.parse(r.out)) {
              if (String(m.argument ?? "").includes(`sink_name=${TAP_NAME}`)) { id = m.index; break; }
            }
          } catch { /* fall through */ }
        }
        if (id != null && id !== "") this.runPw("pactl", ["unload-module", String(id)]);
      }
    } else {
      try { this.sm?.kill("SIGTERM"); } catch {}
      try { this.daemon?.kill("SIGTERM"); } catch {}
      // pipewire re-forks — the spawn pid is often a dead parent; the
      // runtime dir marks the real survivors
      this.killByRuntimeDir();
      await sleep(300);
      try { this.sm?.kill("SIGKILL"); } catch {}
      try { this.daemon?.kill("SIGKILL"); } catch {}
      this.killByRuntimeDir();
    }
  }
}
