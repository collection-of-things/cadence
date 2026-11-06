// env.mjs — repo paths, tool discovery, small utilities shared by the CLI.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// this file: helpers/src/lib/env.mjs
export const HELPERS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SKILL_DIR = resolve(HELPERS, "..");
// verify-cadence -> skills -> .agents -> repo root
export const REPO = resolve(SKILL_DIR, "..", "..", "..");
export const FIXTURES = join(REPO, "test", "fixtures", "library");
export const RUNS_ROOT = join(REPO, "verify-runs");

export function electronBinary() {
  // pnpm keeps real binaries in the virtual store; the .bin entry is a shim
  // playwright cannot exec directly.
  const pnpmDir = join(REPO, "node_modules", ".pnpm");
  const hit = readdirSync(pnpmDir).find((d) => /^electron@/.test(d));
  if (!hit) return null;
  const bin = join(pnpmDir, hit, "node_modules", "electron", "dist", "electron");
  return existsSync(bin) ? bin : null;
}

export function packagedBinary() {
  const p = join(REPO, "apps", "desktop", "release", "linux-unpacked", "cadence");
  return existsSync(p) ? p : null;
}

export function audioBinary() {
  for (const p of [
    join(REPO, "target", "debug", "cadence-audio"),
    join(REPO, "target", "release", "cadence-audio"),
  ]) if (existsSync(p)) return p;
  return null;
}

export function have(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, ...opts });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function sh(script, opts = {}) {
  return run("bash", ["-c", script], opts);
}

export function fixtureTracks() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(flac|wav|mp3|m4a)$/i.test(e.name)) out.push(p);
    }
  };
  if (existsSync(FIXTURES)) walk(FIXTURES);
  return out.sort();
}

export function newRunDir(slug = "run") {
  // millisecond precision + a collision suffix — two runs in the same
  // second must never share a dir (stale analysis/evidence poisoning)
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);
  let dir = join(RUNS_ROOT, `${ts}-${slug}`);
  for (let i = 1; existsSync(dir); i++) dir = join(RUNS_ROOT, `${ts}-${slug}-${i}`);
  for (const sub of ["evidence", "logs", "audio", "state"]) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

export class AbortedError extends Error {
  constructor(what) { super(`aborted while waiting for ${what}`); this.name = "AbortedError"; }
}

/** Wait until fn() returns truthy; throws with `what` after timeout.
 * `aborted` (optional predicate) throws AbortedError promptly — callers
 * interrupted mid-wait must not keep going and spawn more resources. */
export async function waitFor(fn, { timeout = 15_000, every = 250, what = "condition", aborted = null } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (aborted?.()) throw new AbortedError(what);
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      last = e;
    }
    await sleep(every);
  }
  if (aborted?.()) throw new AbortedError(what);
  throw new Error(`timed out waiting for ${what} (${timeout}ms)`);
}
