// Lifecycle regression tests — resources acquired mid-launch must be
// reachable by signal teardown even before ctx exists.
// Run via `cadence-verify selftest` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeLaunches, teardownActiveLaunches, teardownRecorded } from "../src/lib/session.mjs";
import { UD_MARKER, procAlive, procStartTime } from "../src/lib/isolation.mjs";
import { sleep } from "../src/lib/env.mjs";

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
