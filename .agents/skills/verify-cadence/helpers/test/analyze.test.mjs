// Analyzer regression tests — negative inputs must be REJECTED, not
// silently passed or crashed past. Run via `cadence-verify selftest`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPERS, fixtureTracks } from "../src/lib/env.mjs";

const ANALYZER = join(HELPERS, "src", "analyze_audio.py");
const REF = fixtureTracks()[0];
const RATE = 48000, CH = 2;

function decodeRef(seconds) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-t", String(seconds), "-i", REF,
    "-f", "f32le", "-ar", String(RATE), "-ac", String(CH), "-"],
    { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr?.toString());
  return r.stdout;
}

function analyze(capPath, extra = []) {
  const out = capPath + ".json";
  const r = spawnSync("python3", [ANALYZER, capPath,
    "--ref", REF, "--rate", String(RATE), "--channels", String(CH),
    "--min-audible-s", "1.5", "--out", out, ...extra]);
  let json = null;
  try { json = JSON.parse(readFileSync(out, "utf8")); } catch {}
  return { code: r.status, json, stderr: r.stderr?.toString() };
}

function setup() {
  const d = mkdtempSync(join(tmpdir(), "cadence-atest-"));
  return { d, cap: join(d, "cap.f32le") };
}

test("analyzer accepts a real capture of the reference", () => {
  const { d, cap } = setup();
  writeFileSync(cap, decodeRef(6));
  const r = analyze(cap);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.checks.find((c) => c.name === "capture not silent")?.ok);
  rmSync(d, { recursive: true, force: true });
});

test("analyzer rejects a missing file", () => {
  const { d, cap } = setup();
  const r = analyze(cap);
  assert.notEqual(r.code, 0);
  assert.equal(r.json.checks.find((c) => c.name === "capture input valid")?.ok, false);
  rmSync(d, { recursive: true, force: true });
});

test("analyzer rejects an empty capture", () => {
  const { d, cap } = setup();
  writeFileSync(cap, Buffer.alloc(0));
  const r = analyze(cap);
  assert.notEqual(r.code, 0);
  rmSync(d, { recursive: true, force: true });
});

test("analyzer rejects a capture with trailing partial samples", () => {
  const { d, cap } = setup();
  const good = decodeRef(3);
  // 1-3 trailing bytes: np.fromfile silently truncates — the byte-size
  // check must catch it
  for (const extra of [1, 2, 3]) {
    writeFileSync(cap, Buffer.concat([good, Buffer.alloc(extra)]));
    const r = analyze(cap);
    assert.notEqual(r.code, 0, `trailing ${extra} byte(s) should be rejected`);
    assert.equal(r.json.checks.find((c) => c.name === "capture input valid")?.ok, false);
  }
  // and a whole-but-misaligned frame (mult of 4, not of frame size)
  writeFileSync(cap, Buffer.concat([good, Buffer.alloc(4)]));
  const r2 = analyze(cap);
  assert.notEqual(r2.code, 0);
  rmSync(d, { recursive: true, force: true });
});

test("analyzer rejects NaN/Inf PCM", () => {
  const { d, cap } = setup();
  const good = decodeRef(3);
  const buf = Buffer.from(good);
  buf.writeFloatLE(Number.NaN, 4 * CH * 100);
  writeFileSync(cap, buf);
  const r = analyze(cap);
  assert.notEqual(r.code, 0);
  assert.equal(r.json.checks.find((c) => c.name === "capture input valid")?.ok, false);
  rmSync(d, { recursive: true, force: true });
});

test("analyzer rejects pure silence (muted-output negative control analogue)", () => {
  const { d, cap } = setup();
  writeFileSync(cap, Buffer.alloc(RATE * CH * 4 * 3)); // 3s of zeros
  const r = analyze(cap);
  assert.notEqual(r.code, 0);
  assert.equal(r.json.checks.find((c) => c.name === "capture not silent")?.ok, false);
  rmSync(d, { recursive: true, force: true });
});

test("analyzer rejects a capture ending inside the pause window", () => {
  const { d, cap } = setup();
  // 5s of audio, pause claimed at 4.5s -> window [4.95,5.95] outruns the file
  writeFileSync(cap, decodeRef(5));
  const r = analyze(cap, ["--pause-point-s", "4.5"]);
  assert.notEqual(r.code, 0);
  assert.equal(r.json.checks.find((c) => c.name === "pause silences output")?.ok, false);
  rmSync(d, { recursive: true, force: true });
});

test("analyzer rejects a too-short capture", () => {
  const { d, cap } = setup();
  writeFileSync(cap, decodeRef(0.3));
  const r = analyze(cap);
  assert.notEqual(r.code, 0);
  rmSync(d, { recursive: true, force: true });
});
