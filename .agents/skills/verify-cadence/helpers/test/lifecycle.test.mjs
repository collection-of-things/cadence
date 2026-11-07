// Lifecycle regression tests — resources acquired mid-launch must be
// reachable by signal teardown even before ctx exists.
// Run via `cadence-verify selftest` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { activeLaunches, teardownActiveLaunches, teardownRecorded } from "../src/lib/session.mjs";
import { UD_MARKER, procAlive, procStartTime, procIds, procComm } from "../src/lib/isolation.mjs";
import { sleep } from "../src/lib/env.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

/** Direct children of `pid` with the given comm name (via /proc stat). */
function childCommPids(pid, comm) {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const ids = procIds(Number(d));
    if (ids?.ppid === pid && procComm(Number(d)) === comm) out.push(Number(d));
  }
  return out;
}

test("teardownActiveLaunches reaps resources acquired mid-launch", async () => {
  // simulate a launch that got as far as spawning a detached proc + an
  // owned profile dir, then was interrupted before ctx existed
  const ud = mkdtempSync(join(tmpdir(), "cadence-lc-ud-"));
  writeFileSync(join(ud, UD_MARKER), "test\n");
  const proc = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  proc.unref();
  const fakePwDir = mkdtempSync(join(tmpdir(), "cadence-pw-"));
  const r = {
    xvfb: null,
    pw: { stop: async () => {}, removeOwnedDirs: () => rmSync(fakePwDir, { recursive: true, force: true }) },
    app: null,
    proc,
    browser: null,
    ud,
    recorders: [],
  };
  activeLaunches.add(r);
  assert.ok(procAlive(proc.pid));
  await teardownActiveLaunches();
  await sleep(100);
  assert.equal(activeLaunches.size, 0);
  assert.equal(procAlive(proc.pid), false, "detached proc must be reaped");
  assert.equal(existsSync(ud), false, "owned profile dir must be removed");
  assert.equal(existsSync(fakePwDir), false, "owned runtime dir must be removed");
});

test("teardownActiveLaunches tolerates empty + already-dead state", async () => {
  await teardownActiveLaunches(); // nothing registered — must not throw
  const r = { xvfb: null, pw: null, app: null, proc: null, browser: null, ud: null, recorders: [] };
  activeLaunches.add(r);
  await teardownActiveLaunches();
  assert.equal(activeLaunches.size, 0);
});

const HARNESS_COMMS = new Set(["Xvfb", "pipewire", "wireplumber", "pw-cat", "electron", "cadence", "cadence-audio"]);

/** Pids of `pid`'s direct children that look like harness resources. */
function harnessChildren(pid) {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const ids = procIds(Number(d));
    const comm = procComm(Number(d));
    if (ids?.ppid === pid && comm && HARNESS_COMMS.has(comm)) out.push(Number(d));
  }
  return out;
}

/** Spawn a CLI command, watch for its first harness child, SIGTERM at the
 * worst moment (mid-bringup), then prove every observed child is dead —
 * including any spawned between the signal and the CLI's exit. */
async function signalAtSpawn(cliArgs, { iterations = 1, timeout = 120_000 } = {}) {
  for (let i = 0; i < iterations; i++) {
    const slug = `sigx-${cliArgs[0]}-${Date.now()}-${i}`;
    const cli = spawn(process.execPath, [CLI, ...cliArgs, "--slug", slug], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    cli.stdout.on("data", (d) => { out += d; });
    cli.stderr.on("data", (d) => { out += d; });
    const observed = new Map(); // pid -> comm, everything we ever saw spawn
    const seen = new Set();
    let signaled = false;
    const deadline = Date.now() + timeout;
    const exited = new Promise((res) => cli.on("exit", (c) => res(c)));
    // poll CONTINUOUSLY until the cli exits — children spawned between the
    // signal and the exit are exactly the respawn-leak this guards
    while (Date.now() < deadline && cli.exitCode === null) {
      for (const p of harnessChildren(cli.pid)) {
        if (!seen.has(p)) { seen.add(p); observed.set(p, procComm(p)); }
      }
      if (!signaled && seen.size > 0) {
        process.kill(cli.pid, "SIGTERM");
        signaled = true;
      }
      await sleep(4);
    }
    if (!signaled) {
      try { cli.kill("SIGKILL"); } catch {}
      assert.fail(`iteration ${i}: never observed a harness child of cli pid ${cli.pid}:\n${out.slice(-800)}`);
    }
    const code = await Promise.race([exited, sleep(45_000).then(() => {
      try { cli.kill("SIGKILL"); } catch {}
      return -1;
    })]);
    assert.equal(code, 143, `iteration ${i}: expected exit 143 from signal teardown, got ${code}\n${out.slice(-800)}`);
    await sleep(400);
    for (const [p, comm] of observed) {
      // a zombie is dead-but-unreaped — count only a live process as a leak
      const stat = existsSync(`/proc/${p}`) ? readFileSync(`/proc/${p}/stat`, "utf8") : null;
      const state = stat?.split(") ")[1]?.[0];
      assert.ok(stat === null || state === "Z",
        `iteration ${i}: leaked ${comm} pid ${p} (spawned mid-launch, survived teardown)`);
    }
    // nothing else left hanging under a (now dead) cli
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      const ids = procIds(Number(d));
      if (ids?.ppid === cli.pid) {
        assert.fail(`iteration ${i}: stray child ${d} (${procComm(Number(d))}) survived signal teardown`);
      }
    }
  }
}

test("SIGTERM mid-bringup reaps every spawned resource (run, repeated)", async () => {
  await signalAtSpawn(["run", "smoke"], { iterations: 3 });
}, { timeout: 300_000 });

test("SIGTERM mid-bringup reaps every spawned resource (launch, repeated)", async () => {
  await signalAtSpawn(["launch"], { iterations: 2 });
}, { timeout: 300_000 });

test("recorded teardown never escalates after an ownership check fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cadence-stop-test-"));
  const sentinel = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    writeFileSync(join(dir, "session.json"), JSON.stringify({
      pid: sentinel.pid,
      pidStartTime: procStartTime(sentinel.pid),
      userData: join(dir, "unrelated-profile"),
      display: ":99",
    }));
    const meta = await teardownRecorded(dir);
    await sleep(100);
    assert.match(meta.teardownNotes[0], /skipped kill/);
    assert.equal(procAlive(sentinel.pid), true, "failed ownership must block SIGTERM and SIGKILL");
  } finally {
    sentinel.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
