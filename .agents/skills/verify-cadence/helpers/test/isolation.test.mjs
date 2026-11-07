// Harness regression tests: isolation + lifecycle guards.
// Run via `cadence-verify selftest` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareUserData, sanitizedAppEnv, harnessEnv, UD_MARKER,
  freePort, portListenerPids, procStartTime, procCmdline, procEnv,
  verifyRecordedProcess, isPrivateAudioProc, descendantPids,
} from "../src/lib/isolation.mjs";
import { Pw } from "../src/lib/pipewire.mjs";
import { newRunDir } from "../src/lib/env.mjs";

test("--pw session is refused at construction (fail closed)", () => {
  assert.throws(() => new Pw({ mode: "session" }), /not supported/);
});

test("prepareUserData rejects the real profile", () => {
  const real = join(homedir(), ".config", "cadence");
  assert.throws(() => prepareUserData(real), /real Cadence profile/);
  assert.throws(() => prepareUserData(join(real, "sub")), /real Cadence profile/);
});

test("prepareUserData rejects an existing unmarked dir", () => {
  const d = mkdtempSync(join(tmpdir(), "cadence-notours-"));
  assert.throws(() => prepareUserData(d), /not harness-owned/);
  rmSync(d, { recursive: true, force: true });
});

test("prepareUserData accepts fresh + marker-owned dirs", () => {
  const a = prepareUserData(null);
  assert.ok(existsSync(join(a, UD_MARKER)));
  assert.equal(prepareUserData(a), a); // reuse allowed once marked
  const fresh = join(tmpdir(), `cadence-verify-udtest-${Date.now()}`);
  assert.equal(prepareUserData(fresh), fresh);
  assert.ok(existsSync(join(fresh, UD_MARKER)));
  rmSync(a, { recursive: true, force: true });
  rmSync(fresh, { recursive: true, force: true });
});

test("harnessEnv drops display/session/audio overrides", () => {
  const dirty = {
    DISPLAY: ":0", XAUTHORITY: "/home/u/.Xauthority",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    PULSE_SERVER: "unix:/run/user/1000/pulse/native",
    ALSA_CONFIG_PATH: "/etc/asound.conf",
    PIPEWIRE_RUNTIME_DIR: "/run/user/1000",
    XDG_RUNTIME_DIR: "/run/user/1000",
    CADENCE_UI_URL: "http://localhost:5173",
    CADENCE_AUDIO_BIN: "/stale/binary",
    ELECTRON_RUN_AS_NODE: "1",
  };
  const saved = {};
  for (const [k, v] of Object.entries(dirty)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const env = harnessEnv({ DISPLAY: ":99" });
    for (const k of Object.keys(dirty)) {
      if (k === "DISPLAY") assert.equal(env.DISPLAY, ":99");
      else assert.equal(env[k], undefined, `${k} should be dropped`);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("sanitizedAppEnv pins the resolved audio binary + private asound", () => {
  const bin = process.execPath; // any existing file works for the pin check
  const env = sanitizedAppEnv({ audioBin: bin, asoundPath: "/tmp/x-asound.conf", extra: { DISPLAY: ":91" } });
  assert.equal(env.CADENCE_AUDIO_BIN, bin);
  assert.equal(env.ALSA_CONFIG_PATH, "/tmp/x-asound.conf");
  assert.throws(() => sanitizedAppEnv({ audioBin: null }), /CADENCE_AUDIO_BIN/);
  assert.throws(() => sanitizedAppEnv({ audioBin: "/nonexistent/nope" }), /missing/);
});

test("freePort returns a bindable port; portListenerPids finds the owner", async () => {
  const port = await freePort();
  assert.ok(port > 0 && port < 65536);
  // free port: nobody listening
  assert.equal(portListenerPids(port).size, 0);
  // now listen and verify OUR pid is reported (this is the readlink path —
  // a read() of the fd symlink would fail and report nothing)
  const server = createServer();
  await new Promise((res) => server.listen(port, "127.0.0.1", res));
  const owners = portListenerPids(port);
  server.close();
  assert.ok(owners.has(process.pid), `expected pid ${process.pid} in ${[...owners]}`);
});

test("proc introspection on self", () => {
  const st = procStartTime(process.pid);
  assert.ok(st && /^\d+$/.test(st));
  const argv = procCmdline(process.pid);
  assert.ok(argv.length > 0);
  const env = procEnv(process.pid);
  assert.ok(env.PATH !== undefined);
  assert.ok(descendantPids(process.pid).has(process.pid));
  assert.equal(isPrivateAudioProc(process.pid), false); // comm=node, not an audio daemon
});

test("verifyRecordedProcess fails closed on missing starttime", () => {
  // alive pid but no recorded starttime -> cannot prove identity -> refuse
  const v = verifyRecordedProcess(process.pid, { pidStartTime: null });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(" "), /no recorded starttime/);
});

test("verifyRecordedProcess fails on wrong starttime/argv/display", () => {
  const good = verifyRecordedProcess(process.pid, {
    pidStartTime: procStartTime(process.pid),
  });
  assert.equal(good.ok, true, good.reasons.join("; "));
  const reused = verifyRecordedProcess(process.pid, { pidStartTime: "999999999" });
  assert.equal(reused.ok, false);
  const wrongUd = verifyRecordedProcess(process.pid, {
    pidStartTime: procStartTime(process.pid),
    userData: "/some/other/profile",
  });
  assert.equal(wrongUd.ok, false);
});

test("newRunDir produces unique dirs (no same-second collision)", () => {
  const a = newRunDir("selftest-uniq");
  const b = newRunDir("selftest-uniq");
  assert.notEqual(a, b);
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});
