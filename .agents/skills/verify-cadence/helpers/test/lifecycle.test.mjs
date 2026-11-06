// Lifecycle regression tests — resources acquired mid-launch must be
// reachable by signal teardown even before ctx exists.
// Run via `cadence-verify selftest` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
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

test("SIGTERM while Xvfb is still coming up reaps it (real signal-at-spawn)", async () => {
  // Reproduces the reviewer finding: signal lands inside startXvfb's
  // readiness wait — before this fix the spawned Xvfb was orphaned.
  const slug = `sigx-${Date.now()}`;
  const cli = spawn(process.execPath, [CLI, "run", "smoke", "--slug", slug], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  cli.stdout.on("data", (d) => { out += d; });
  cli.stderr.on("data", (d) => { out += d; });

  // poll fast for the Xvfb child of the CLI, then signal IMMEDIATELY —
  // racing its readiness window is the point
  let xvfbPid = null;
  const deadline = Date.now() + 60_000;
  while (!xvfbPid && Date.now() < deadline && cli.exitCode === null) {
    xvfbPid = childCommPids(cli.pid, "Xvfb")[0] ?? null;
    if (!xvfbPid) await sleep(5);
  }
  assert.ok(xvfbPid, `never observed an Xvfb child of cli pid ${cli.pid}:\n${out.slice(-800)}`);

  process.kill(cli.pid, "SIGTERM");
  const code = await new Promise((res) => {
    cli.on("exit", (c) => res(c));
    setTimeout(() => res(-1), 30_000);
  });
  assert.equal(code, 143, `expected exit 143 from signal teardown, got ${code}`);
  await sleep(500);
  assert.equal(procAlive(xvfbPid), false, `Xvfb pid ${xvfbPid} leaked`);
  // no harness daemons left behind either
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const ids = procIds(Number(d));
    if (ids?.ppid === cli.pid) {
      assert.fail(`stray child ${d} (${procComm(Number(d))}) survived signal teardown`);
    }
  }
}, { timeout: 120_000 });

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
