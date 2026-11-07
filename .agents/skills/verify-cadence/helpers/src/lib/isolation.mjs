// isolation.mjs — hard guarantees that a verify run can only ever touch
// harness-owned resources: a sanitized app environment, profile dirs the
// harness created, CDP ports we verified free, and process kills that only
// land on the exact recorded process (never a reused pid).
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { audioBinary } from "./env.mjs";

/** Marker written into every --user-data-dir the harness creates. Reuse is
 * only allowed for dirs carrying it — never a real user profile. */
export const UD_MARKER = ".cadence-verify-owned";

/** Env vars that could route the app outside the harness's private world:
 * real display/session bus, real audio servers, dev-server URLs, stale
 * binary overrides. Everything here is dropped before spawn; whatever the
 * run needs is re-added explicitly below. */
const DROP_ENV = [
  // turns the Electron binary into plain node — kills the launch
  "ELECTRON_RUN_AS_NODE",
  // renderer URL override: an inherited dev-server URL would load code the
  // run is not testing (stale or foreign UI)
  "CADENCE_UI_URL",
  // audio backend override: replaced with the resolved repo binary below
  "CADENCE_AUDIO_BIN",
  // streaming-provider binary/token overrides must not leak in either
  "CADENCE_LIBRESPOT_BIN",
  "CADENCE_APPLE_DEVELOPER_TOKEN",
  "CADENCE_APPLE_TOKEN_ENDPOINT",
  "CADENCE_SPOTIFY_USERNAME",
  "CADENCE_SPOTIFY_PASSWORD",
  "CADENCE_SPOTIFY_ACCESS_TOKEN",
  "CADENCE_SPOTIFY_TOKEN",
  // real audio routes: PulseAudio socket/sink selection and ALSA config.
  // The app talks cpal -> ALSA; without sanitation it could open the real
  // default device or the user's Pulse/PipeWire server.
  "PULSE_SERVER", "PULSE_SINK", "PULSE_SOURCE", "PULSE_COOKIE", "PULSE_CLIENTCONFIG",
  "ALSA_CONFIG_PATH", "ALSA_CARD", "ALSA_PCM_CARD", "ALSA_DEVICE",
  "PIPEWIRE_REMOTE", "PIPEWIRE_RUNTIME_DIR", "PIPEWIRE_CORE", "PIPEWIRE_DEBUG",
  "SNAP", "FLATPAK_ID",
  // display + session: the app must never see the user's X/Wayland session,
  // session bus, or desktop-session state
  "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "MIR_SOCKET",
  "DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS",
  "XDG_RUNTIME_DIR", "XDG_SESSION_ID", "XDG_SESSION_TYPE", "XDG_SESSION_CLASS",
  "XDG_SEAT", "XDG_VTNR", "DESKTOP_SESSION", "SESSION_MANAGER",
];

/** Parent env minus every route out of the private session. Used for the
 * spawned app (via sanitizedAppEnv) and for harness pw-tools alike — a tool
 * run with the private core vars set is just as isolated. */
export function harnessEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  return Object.assign(env, extra);
}

/**
 * Build the spawned app's environment: the harness env above, plus the
 * pieces the run owns pinned explicitly.
 *  - extra: caller-supplied additions (DISPLAY set to the private Xvfb, the
 *    private-core PIPEWIRE_* vars).
 *  - audioBin: required — the resolved repo cadence-audio binary. We set
 *    CADENCE_AUDIO_BIN explicitly so a stale env value or a wrong-profile
 *    fallback can never run unverified code.
 *  - asoundPath: private ALSA config; makes the ALSA default device the
 *    pipewire plugin (which honors PIPEWIRE_RUNTIME_DIR → the private core).
 *    Without it ALSA's compiled-in default could resolve to real hardware.
 */
export function sanitizedAppEnv({ extra = {}, audioBin, asoundPath } = {}) {
  if (!audioBin) throw new Error("no resolved cadence-audio binary — refusing to spawn without CADENCE_AUDIO_BIN pinned");
  if (!existsSync(audioBin)) throw new Error(`cadence-audio binary missing at ${audioBin} — build services/audio first`);
  const env = harnessEnv(extra);
  env.CADENCE_AUDIO_BIN = audioBin;
  if (asoundPath) env.ALSA_CONFIG_PATH = asoundPath;
  return env;
}

/** Minimal ALSA config whose default PCM is the pipewire plugin — with
 * PIPEWIRE_RUNTIME_DIR set (private mode) that lands in the private core,
 * and nothing else. Written per-run so it's inspectable evidence. */
export function writePrivateAsound(path) {
  writeFileSync(
    path,
    [
      "# cadence-verify: route the ALSA default device into the PipeWire",
      "# pointed at by PIPEWIRE_RUNTIME_DIR (the run's private core).",
      "# Prevents an inherited/system ALSA config from resolving the",
      "# default device to real hardware or the user's session server.",
      "pcm.!default {",
      "    type pipewire",
      '    hint.description "cadence-verify private pipewire"',
      "}",
      "ctl.!default {",
      "    type hw",
      "    card 0",
      "}",
      "",
    ].join("\n"),
  );
  return path;
}

/** Resolve the repo-built audio binary; throws when absent so a run fails
 * closed before spawning anything. */
export function requireAudioBinary() {
  const bin = audioBinary();
  if (!bin) throw new Error("cadence-audio binary not built — run `cargo build --manifest-path services/audio/Cargo.toml`");
  return bin;
}

/**
 * Resolve --user-data. Only harness-owned dirs are allowed:
 *  - no flag: fresh mkdtemp (owned by definition)
 *  - flag pointing at a nonexistent path: created + marked
 *  - flag pointing at a dir carrying UD_MARKER: reuse (a kept session's profile)
 *  - anything else (incl. an existing unmarked dir or the real
 *    ~/.config/cadence): refused — a real profile could leak the user's
 *    library/credentials into the run or collide with a running instance.
 */
export function prepareUserData(userData) {
  const mark = (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, UD_MARKER), `${new Date().toISOString()}\n`);
    return dir;
  };
  if (!userData) return mark(mkdtempSync(join(tmpdir(), "cadence-verify-ud-")));
  const real = resolve(userData);
  const home = homedir();
  const realProfile = join(home, ".config", "cadence");
  if (real === realProfile || real.startsWith(realProfile + sep)) {
    throw new Error(`--user-data ${real} is the real Cadence profile — refused`);
  }
  if (!existsSync(real)) return mark(real);
  if (existsSync(join(real, UD_MARKER))) return real;
  throw new Error(
    `--user-data ${real} is not harness-owned (no ${UD_MARKER} marker) — refusing to reuse an unmanaged profile`,
  );
}

// ---------------------------------------------------------------------------
// process + port verification
// ---------------------------------------------------------------------------

/** starttime (jiffies since boot, stat field 22) — the pid-reuse signature.
 * A pid is only "the same process" when starttime matches what we recorded. */
export function procStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces/parens — fields restart after the last ')'
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
    return rest[19]; // field 22 overall = index 19 after state(field3)
  } catch {
    return null;
  }
}

/** (pgid, ppid) from /proc stat — verifies group leadership before -pid kills. */
export function procIds(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
    return { ppid: Number(rest[1]), pgid: Number(rest[2]) };
  } catch {
    return null;
  }
}

export function procAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** NUL-separated /proc/pid/cmdline as an argv array. */
export function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** Exact KEY=value lookup in /proc/pid/environ — NUL-delimited, never a
 * substring scan (a path fragment inside an unrelated value must not match). */
export function procEnv(pid) {
  try {
    const out = {};
    for (const e of readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0")) {
      const i = e.indexOf("=");
      if (i > 0) out[e.slice(0, i)] = e.slice(i + 1);
    }
    return out;
  } catch {
    return null;
  }
}

export function procComm(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return null; }
}

/**
 * Verify that `pid` is exactly the process `meta` recorded:
 *  - alive
 *  - same starttime (pid reuse protection)
 *  - cmdline carries this session's --user-data-dir
 *  - environ DISPLAY is this session's private Xvfb display
 * Returns {ok, reasons[]} — never throws.
 */
export function verifyRecordedProcess(pid, meta) {
  const reasons = [];
  if (!pid || !procAlive(pid)) {
    reasons.push("process not alive");
    return { ok: false, reasons };
  }
  // fail closed: no recorded starttime means we cannot prove this is the
  // same process — treat it as unverified, never kill or attach to it
  if (!meta.pidStartTime) {
    reasons.push("no recorded starttime — cannot prove identity");
  } else {
    const st = procStartTime(pid);
    if (st !== meta.pidStartTime) {
      reasons.push(`starttime mismatch (recorded ${meta.pidStartTime}, now ${st}) — pid was reused`);
    }
  }
  const argv = procCmdline(pid);
  if (meta.userData && !argv.includes(`--user-data-dir=${meta.userData}`)) {
    reasons.push("cmdline does not carry this session's --user-data-dir");
  }
  if (meta.cdpPort && !argv.includes(`--remote-debugging-port=${meta.cdpPort}`)) {
    reasons.push(`cmdline does not carry --remote-debugging-port=${meta.cdpPort}`);
  }
  const env = procEnv(pid);
  if (meta.display && env && env.DISPLAY !== meta.display) {
    reasons.push(`DISPLAY=${env.DISPLAY ?? "unset"} != private ${meta.display}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Pids whose comm/name matches the private audio daemons we may sweep —
 * deliberately narrow so an environ signature can never target an unrelated
 * process (the app itself also carries XDG_RUNTIME_DIR). */
export function isPrivateAudioProc(pid) {
  const comm = procComm(pid);
  return comm !== null && /^(pipewire|wireplumber|pw-cat|pw-link|pw-dump|pipewire-pulse)/.test(comm);
}

/** All descendant pids of rootPid (children map built once from /proc). */
export function descendantPids(rootPid) {
  const childrenOf = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const ids = procIds(Number(d));
    if (!ids) continue;
    if (!childrenOf.has(ids.ppid)) childrenOf.set(ids.ppid, []);
    childrenOf.get(ids.ppid).push(Number(d));
  }
  const out = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const c of childrenOf.get(stack.pop()) ?? []) {
      if (!out.has(c)) { out.add(c); stack.push(c); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CDP port ownership
// ---------------------------------------------------------------------------

/** A currently-unused TCP port (bind :0 then release). Small inherent race —
 * callers still verify the listener's owner after spawn. */
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** Pids holding a LISTEN socket on `port` (parsed from /proc/net/tcp{,6}). */
export function portListenerPids(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let lines;
    try { lines = readFileSync(f, "utf8").split("\n").slice(1); } catch { continue; }
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (cols[3] !== "0A") continue; // LISTEN only
      if (cols[1].endsWith(`:${hex}`)) inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return new Set();
  const pids = new Set();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      for (const fd of readdirSync(`/proc/${d}/fd`)) {
        // fd entries are symlinks like "socket:[12345]" — readlink, not read
        const link = readlinkSync(`/proc/${d}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(link);
        if (m && inodes.has(m[1])) { pids.add(Number(d)); break; }
      }
    } catch { /* unreadable fd dir — not ours */ }
  }
  return pids;
}

/** True when anything already answers on the CDP endpoint. */
export async function cdpOccupied(port) {
  if (portListenerPids(port).size > 0) return true;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) return true;
  } catch { /* refused — free */ }
  return false;
}

/** DevTools browser product string (Electron reports "Electron/<ver>"). */
export async function cdpBrowserString(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    return (await r.json())?.Browser ?? null;
  } catch {
    return null;
  }
}

/**
 * Prove the CDP endpoint on `port` belongs to THIS launch: the socket's
 * owner pid must be inside our spawned process tree. Without this, a
 * fixed port could silently connect to an unrelated running
 * Chromium/Electron app.
 */
export async function verifyCdpEndpoint(port, rootPid) {
  const browser = await cdpBrowserString(port);
  if (!browser) return { ok: false, reasons: [`no DevTools endpoint on :${port}`] };
  const reasons = [];
  // The hard proof is socket ownership: the listening socket must belong
  // to a pid inside OUR spawned process tree. Electron reports its CDP
  // product as "Chrome/<ver>" (it IS chromium), so the product string is
  // recorded as detail, not gated on — a foreign Chromium cannot pass the
  // ownership check anyway because it is outside our tree.
  const owners = portListenerPids(port);
  const tree = descendantPids(rootPid);
  if (![...owners].some((p) => tree.has(p))) {
    reasons.push(`:${port} listener pids {${[...owners].join(",")}} are outside pid ${rootPid}'s tree (browser="${browser}")`);
  }
  return { ok: reasons.length === 0, reasons, browser };
}
