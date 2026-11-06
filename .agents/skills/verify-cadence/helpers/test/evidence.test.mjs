// Evidence/verdict regression tests — failure propagation semantics.
// Run via `cadence-verify selftest` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Evidence, AssertionError } from "../src/lib/evidence.mjs";

function makeRunDir() {
  const d = mkdtempSync(join(tmpdir(), "cadence-evtest-"));
  for (const sub of ["evidence", "logs", "audio", "state"]) mkdirSync(join(d, sub), { recursive: true });
  return d;
}

test("check throws on required failure; fail records without throwing", () => {
  const d = makeRunDir();
  const ev = new Evidence(d);
  ev.check("a pass", true);
  assert.throws(() => ev.check("a fail", false), AssertionError);
  ev.fail("a crash", "boom"); // must NOT throw
  const verdict = ev.summary({});
  assert.equal(verdict, "FAIL");
  const v = JSON.parse(readFileSync(join(d, "verdict.json"), "utf8"));
  assert.equal(v.checks.filter((c) => !c.ok && c.required).length, 2);
  rmSync(d, { recursive: true, force: true });
});

test("optional failures record NOTE and never fail the run", () => {
  const d = makeRunDir();
  const ev = new Evidence(d);
  ev.check("note only", false, "tracked defect", { required: false });
  assert.equal(ev.summary({}), "PASS");
  rmSync(d, { recursive: true, force: true });
});

test("a second Evidence instance merges the prior verdict (no history rewrite)", () => {
  const d = makeRunDir();
  const ev1 = new Evidence(d);
  ev1.check("first-run check", true);
  ev1.fail("first-run failure", "launch crashed");
  assert.equal(ev1.summary({}), "FAIL");
  // attach pass: prior FAIL carries forward — summary cannot flip to PASS
  const ev2 = new Evidence(d);
  ev2.check("attach check", true);
  assert.equal(ev2.summary({}), "FAIL");
  const v = JSON.parse(readFileSync(join(d, "verdict.json"), "utf8"));
  assert.ok(v.checks.some((c) => c.prior === true));
  rmSync(d, { recursive: true, force: true });
});

test("verdict.json + SUMMARY.md are written on failure", () => {
  const d = makeRunDir();
  const ev = new Evidence(d);
  ev.fail("launch", "kaboom");
  ev.summary({});
  const s = readFileSync(join(d, "SUMMARY.md"), "utf8");
  assert.match(s, /FAIL/);
  rmSync(d, { recursive: true, force: true });
});
