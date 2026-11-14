import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";

test("launches without the parent Electron app's environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "cadence-launch-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "node_modules", "electron"), { recursive: true });
    copyFileSync(join(import.meta.dirname, "../scripts/launch.mjs"), join(dir, "scripts", "launch.mjs"));
    writeFileSync(join(dir, "node_modules", "electron", "index.js"), `module.exports = ${JSON.stringify(process.execPath)};`);
    writeFileSync(join(dir, "index.js"), `require('fs').writeFileSync('result.json', JSON.stringify({ node: process.env.ELECTRON_RUN_AS_NODE, desktop: process.env.CHROME_DESKTOP, kept: process.env.CADENCE_LAUNCH_TEST, args: process.argv.slice(2) }));`);
    const result = spawnSync(process.execPath, [join(dir, "scripts", "launch.mjs"), "--test-argument"], {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CHROME_DESKTOP: "other.desktop", CADENCE_LAUNCH_TEST: "kept" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toEqual({ kept: "kept", args: ["--test-argument"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
