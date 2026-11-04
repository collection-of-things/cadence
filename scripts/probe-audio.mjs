#!/usr/bin/env node
/**
 * Headless verification of the cadence-audio service contract.
 *
 * - `--probe` on every fixture: format/duration sanity.
 * - `--decode` each fixture to raw PCM: nonzero bytes, correct ballpark size.
 * - JSON-RPC session over stdio against the null sink: ping -> load -> play ->
 *   position events -> prefetch -> gapless boundary -> stop. Fails on timeout
 *   or missing events.
 *
 * Usage: node scripts/probe-audio.mjs [path-to-cadence-audio]
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN =
  process.argv[2] ??
  join("services", "audio", "target", "debug", "cadence-audio");
const FX = join("test", "fixtures", "generated");

const fixtures = [
  { f: "tone-440.flac", rate: 44100, codec: /flac/i },
  { f: "tone-880.wav", rate: 44100, codec: /pcm|wav/i },
  { f: "tone-660.mp3", rate: 44100, codec: /mp3/i },
  { f: "tone-550.m4a", rate: 44100, codec: /alac|aac|m4a|mp4/i },
  { f: "tone-330-24bit96k.flac", rate: 96000, codec: /flac/i },
];

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

if (!existsSync(BIN)) {
  console.error(`binary not found: ${BIN}`);
  process.exit(2);
}

// --- probe -----------------------------------------------------------------
for (const fx of fixtures) {
  const path = join(FX, fx.f);
  if (!existsSync(path)) { ok(`probe ${fx.f}`, false, "fixture missing"); continue; }
  try {
    const out = execFileSync(BIN, ["--probe", path], { timeout: 20000 }).toString();
    const j = JSON.parse(out);
    ok(`probe ${fx.f}`, j.ok === true || j.durationMs > 0, `${j.sampleRateHz}Hz ${j.channels}ch ${j.codec ?? ""}`);
    ok(`probe ${fx.f} rate`, j.sampleRateHz === fx.rate, `want ${fx.rate} got ${j.sampleRateHz}`);
    if (fx.codec) ok(`probe ${fx.f} codec`, fx.codec.test(j.codec ?? ""), j.codec);
  } catch (e) {
    ok(`probe ${fx.f}`, false, String(e).slice(0, 200));
  }
}

// --- decode-to-disk ----------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "cadence-decode-"));
for (const fx of [fixtures[0], fixtures[2], fixtures[4]]) {
  const out = join(tmp, fx.f + ".f32le");
  try {
    execFileSync(BIN, ["--decode", join(FX, fx.f), "--out", out], { timeout: 30000 });
    const size = statSync(out).size;
    // 3s stereo f32 at >=44.1k => >= ~1MB
    ok(`decode ${fx.f}`, size > 500_000, `${(size / 1e6).toFixed(2)}MB`);
  } catch (e) {
    ok(`decode ${fx.f}`, false, String(e).slice(0, 200));
  }
}

// --- JSON-RPC session ---------------------------------------------------------
await new Promise((resolve) => {
  const proc = spawn(BIN, ["--null-sink"], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const events = [];
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const rid = ++id;
      pending.set(rid, { res, rej });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
      setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); rej(new Error("timeout " + method)); } }, 15000);
    });

  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method?.startsWith("event.")) {
        events.push(msg);
      }
    }
  });

  const timer = setTimeout(() => { proc.kill("SIGKILL"); done(["rpc session timed out"]); }, 60000);

  const done = (errors = []) => {
    clearTimeout(timer);
    try { proc.kill("SIGTERM"); } catch {}
    for (const e of errors) ok("rpc session", false, e);
    resolve();
  };

  (async () => {
    try {
      await send("audio.ping");
      ok("rpc ping", true);

      const gen = 7;
      await send("audio.load", {
        queueId: "q1", generationId: gen,
        source: { kind: "file", path: join(FX, "gapless-a.flac") },
      });
      await send("audio.prefetch", { queueId: "q2", path: join(FX, "gapless-b.flac") });
      await send("audio.play", { generationId: gen });
      ok("rpc load+play", true);

      // wait for events
      const deadline = Date.now() + 20000;
      const waitFor = (m, pred = () => true) =>
        new Promise((res, rej) => {
          const t = setInterval(() => {
            const ev = events.find((e) => e.method === m && pred(e.params));
            if (ev) { clearInterval(t); res(ev); }
            else if (Date.now() > deadline) { clearInterval(t); rej(new Error("missing " + m)); }
          }, 50);
        });

      await waitFor("event.position", (p) => p.generationId === gen && p.positionMs > 100);
      ok("rpc position events", true);

      const ended = await waitFor("event.trackEnded", (p) => p.generationId === gen);
      ok("rpc gapless boundary", ended.params.gapless === true, `gapless=${ended.params.gapless}`);

      const started = await waitFor("event.trackStarted", (p) => p.params?.queueId === "q2" || p.queueId === "q2");
      ok("rpc next track started", true, JSON.stringify(started.params));

      await send("audio.stop", { generationId: gen });
      const evCount = events.length;
      ok("rpc event volume sane", evCount >= 3 && evCount < 2000, `${evCount} events`);

      done();
    } catch (e) {
      done([String(e).slice(0, 300)]);
    }
  })();
});

console.log(failures === 0 ? "\nAUDIO PROBE: PASS" : `\nAUDIO PROBE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
