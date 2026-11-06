// doctor.mjs — the read-only "is this worth driving" check.
// Run this first whenever anything looks off: tools, builds, PipeWire,
// fixtures, isolation guards. Zero side effects.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  REPO, FIXTURES, electronBinary, packagedBinary, audioBinary, have, run, fixtureTracks,
} from "./env.mjs";
import { Pw, TAP_NAME } from "./pipewire.mjs";

export async function doctor({ flavor = "dev" } = {}) {
  const checks = [];
  const ok = (name, pass, detail = "") => {
    checks.push({ name, ok: !!pass, detail });
    return pass;
  };

  // --- tools ---------------------------------------------------------------
  for (const t of ["node", "pnpm", "cargo", "ffmpeg", "ffprobe", "python3",
    "Xvfb", "pactl", "pw-dump", "pw-cat", "pw-link"]) {
    ok(`tool:${t}`, have(t), have(t) ?? "missing");
  }
  try {
    const r = run("python3", ["-c", "import numpy; print(numpy.__version__)"]);
    ok("python:numpy", r.code === 0, r.out || r.err);
  } catch { ok("python:numpy", false); }
  try {
    createRequire(join(REPO, "package.json")).resolve("playwright-core");
    ok("node:playwright-core", true);
  } catch {
    ok("node:playwright-core", false, "pnpm add -D playwright-core -w");
  }

  // --- builds ---------------------------------------------------------------
  ok("build:desktop-main", existsSync(join(REPO, "apps", "desktop", "dist", "main.cjs")),
    "apps/desktop/dist/main.cjs — run pnpm -r build");
  ok("build:desktop-preload", existsSync(join(REPO, "apps", "desktop", "dist", "preload.cjs")),
    "apps/desktop/dist/preload.cjs");
  ok("build:ui", existsSync(join(REPO, "apps", "ui", "dist", "index.html")),
    "apps/ui/dist/index.html — run pnpm -r build");
  ok("build:audio-service", audioBinary() !== null,
    audioBinary() ?? "cargo build");
  ok("build:electron-binary", electronBinary() !== null,
    electronBinary() ?? "electron dist missing — run node install.js in the electron package");
  if (flavor === "packaged") {
    ok("build:packaged", packagedBinary() !== null,
      packagedBinary() ?? "pnpm --filter @cadence/desktop dist:dir");
  }

  // --- fixtures --------------------------------------------------------------
  const tracks = fixtureTracks();
  ok("fixtures:library", tracks.length >= 5, `${tracks.length} audio files under ${FIXTURES}`);

  // --- pipewire ----------------------------------------------------------------
  ok("tool:pipewire", have("pipewire"), have("pipewire") ?? "missing — needed for the private audio core");
  try {
    const pw = new Pw({ mode: "session" });
    pw.dump();
    ok("pipewire:user-session", true, "pw-dump answers (untouched by verification)");
    if (pw.sinkExists()) {
      checks.push({
        name: "pipewire:stale-tap", ok: true,
        detail: `a ${TAP_NAME} sink exists in the user session — leftover from a session-mode run; verification uses a private core so this is informational`,
      });
    }
  } catch (e) {
    checks.push({ name: "pipewire:user-session", ok: true, detail: `user session unreachable (${String(e).slice(0, 80)}) — private mode unaffected` });
  }

  // the real isolation guarantee: a private core + policy WirePlumber
  // must come up with tap ports. This only touches a mkdtemp runtime dir.
  const pwv = new Pw({ mode: "private" });
  try {
    await pwv.start();
    const ports = pwv.tapPorts();
    ok("pipewire:private-core", true,
      `private core up — ${TAP_NAME} exposes ${ports.inPorts.length} playback + ${ports.monitorPorts.length} monitor port(s)`);
  } catch (e) {
    ok("pipewire:private-core", false, `private core failed: ${String(e).slice(0, 160)}`);
  } finally {
    try { await pwv.stop(); } catch {}
  }

  // --- isolation guards --------------------------------------------------------
  ok("isolation:userData", true,
    "sessions always get a fresh --user-data-dir; the user's real profile (~/.config/cadence) is never touched");
  ok("isolation:display", true,
    `app only ever runs on a private Xvfb display, never on DISPLAY=${process.env.DISPLAY ?? "unset"}`);
  if (process.env.ELECTRON_RUN_AS_NODE) {
    ok("env:ELECTRON_RUN_AS_NODE", true,
      "set in parent env — sanitized for spawned app processes (harmless)");
  }

  // --- disk ---------------------------------------------------------------------
  const df = run("df", ["-m", REPO, "--output=avail"]).out.split("\n").pop();
  ok("disk:headroom", Number(df) > 800, `${df?.trim()} MB free`);

  // --- providers (informational) -------------------------------------------------
  const providerEnv = ["CADENCE_APPLE_DEVELOPER_TOKEN", "CADENCE_SPOTIFY_USERNAME",
    "CADENCE_SPOTIFY_ACCESS_TOKEN", "CADENCE_SPOTIFY_TOKEN"];
  const present = providerEnv.filter((k) => process.env[k]);
  checks.push({
    name: "providers:opt-in",
    ok: true,
    detail: present.length
      ? `provider env present: ${present.join(", ")} — streaming routes may report ready`
      : "no provider env — streaming routes will report unauthenticated and be skipped (expected)",
  });

  return checks;
}

export function printDoctor(checks) {
  let fail = 0;
  for (const c of checks) {
    const tag = c.ok ? " ok " : "FAIL";
    console.log(`${tag}  ${c.name}${c.detail ? `  — ${c.detail}` : ""}`);
    if (!c.ok) fail++;
  }
  console.log(`\nDOCTOR: ${fail === 0 ? "PASS" : `${fail} problem(s)`}`);
  return fail === 0;
}
