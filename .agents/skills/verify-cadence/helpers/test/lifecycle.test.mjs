// Lifecycle regression tests — resources acquired mid-launch must be
// reachable by signal teardown even before ctx exists.
// Run via `cadence-verify selftest` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeLaunches, teardownActiveLaunches } from "../src/lib/session.mjs";
import { UD_MARKER, procAlive } from "../src/lib/isolation.mjs";
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
