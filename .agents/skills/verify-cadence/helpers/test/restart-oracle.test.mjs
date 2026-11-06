// Restart oracle regression tests — the restore contract itself.
// Run via `cadence-verify selftest` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRestore } from "../src/lib/restart-oracle.mjs";

const track = (id, title = id) => ({ id, title, artists: [{ name: "A" }], album: "Alb" });
const snap = (status, positionMs, t) => ({ status, positionMs, current: t ? { track: t } : null });
const queue = (tracks, currentIndex = 0) => ({
  items: tracks.map((t, i) => ({ queueId: `q${i}`, track: t })),
  currentIndex,
});

function goodCase() {
  const tracks = [track("t1", "Beacon"), track("t2", "Meridian"), track("t3", "Vantage")];
  return {
    before: snap("playing", 5000, tracks[0]),
    qBefore: queue(tracks, 0),
    restored: snap("paused", 4900, tracks[0]),
    qAfter: queue(tracks, 0),
    persisted: { positionMs: 4900 },
    strayStreams: 0,
    quitMode: "graceful",
    resumed: snap("playing", 5000, tracks[0]),
    resumedLater: snap("playing", 6000, tracks[0]),
  };
}

const failed = (obs) => obs.filter(([, ok]) => !ok).map(([n]) => n);

test("a true restore passes every observation", () => {
  assert.deepEqual(failed(evaluateRestore(goodCase())), []);
});

test("zero quit position is meaningless and fails", () => {
  const c = goodCase();
  c.before.positionMs = 0;
  assert.ok(failed(evaluateRestore(c)).includes("position was meaningfully mid-track at quit"));
});

test("missing/zero persisted position fails — no stale-self agreement", () => {
  const c = goodCase();
  c.persisted = null;
  const f = failed(evaluateRestore(c));
  assert.ok(f.includes("persisted position is meaningful"));
  assert.ok(f.includes("persisted position matches quit snapshot"));
});

test("persisted position far from the quit snapshot fails", () => {
  const c = goodCase();
  c.persisted = { positionMs: 12000 }; // stale nonzero state
  c.restored.positionMs = 11800;       // restore agreeing with stale state still must not pass
  const f = failed(evaluateRestore(c));
  assert.ok(f.includes("persisted position matches quit snapshot"));
});

test("zero restored position fails", () => {
  const c = goodCase();
  c.restored.positionMs = 0;
  assert.ok(failed(evaluateRestore(c)).includes("position restored within bounded drift"));
});

test("reordered queue identities fail", () => {
  const c = goodCase();
  c.qAfter.items.reverse();
  const f = failed(evaluateRestore(c));
  assert.ok(f.includes("queue restored (ordered track identities)") || f.includes("queue currentIndex restored"));
});

test("different currentIndex fails", () => {
  const c = goodCase();
  c.qAfter.currentIndex = 1;
  assert.ok(failed(evaluateRestore(c)).includes("queue currentIndex restored"));
});

test("wrong restored track fails", () => {
  const c = goodCase();
  c.restored = snap("paused", 4900, track("t2", "Meridian"));
  assert.ok(failed(evaluateRestore(c)).includes("same track restored"));
});

test("autoplay on relaunch fails", () => {
  const c = goodCase();
  c.restored.status = "playing";
  assert.ok(failed(evaluateRestore(c)).includes("comes back PAUSED (no autoplay)"));
});

test("stray stream while paused fails", () => {
  const c = goodCase();
  c.strayStreams = 1;
  assert.ok(failed(evaluateRestore(c)).includes("no audio stream while paused"));
});

test("killed quit fails the contract", () => {
  const c = goodCase();
  c.quitMode = "killed";
  assert.ok(failed(evaluateRestore(c)).includes("graceful quit"));
});

test("no resume (both attempts failed) is an explicit failure", () => {
  const c = goodCase();
  c.resumed = null;
  c.resumedLater = null;
  assert.ok(failed(evaluateRestore(c)).includes("resume after restore works"));
});

test("resume on the wrong track fails", () => {
  const c = goodCase();
  c.resumed = snap("playing", 1000, track("t2", "Meridian"));
  c.resumedLater = snap("playing", 2000, track("t2", "Meridian"));
  assert.ok(failed(evaluateRestore(c)).includes("resume plays the restored track"));
});

test("resume that does not advance fails", () => {
  const c = goodCase();
  c.resumedLater = snap("playing", 5000, c.resumed.current.track);
  assert.ok(failed(evaluateRestore(c)).includes("resume position advances"));
});
