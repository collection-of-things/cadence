// VMP-sign Cadence's development Electron so DRM streaming providers
// (Apple Music, Spotify web) get production Widevine licenses on macOS and
// Windows. Castlabs' prebuilt Electron carries only a DEVELOPMENT VMP
// signature, which production license servers refuse — Apple Music then
// fails with MEDIA_LICENSE (-42585) even for a signed-in subscriber. Linux
// has no VMP requirement.
//
// Prerequisites (one time, interactive — your own Castlabs EVS account):
//   the castlabs-evs client (see the venv note below), then
//   <python> -m castlabs_evs.account signup     # or: account reauth
//
//   pnpm vmp:sign           sign node_modules' Electron in place
//   pnpm vmp:sign --check   report whether it is signed, change nothing
//
// Re-run after anything reinstalls Electron (a fresh `pnpm install`).
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const binary = require("electron"); // path to the Electron executable
const dist = process.platform === "darwin" ? resolve(binary, "../../../..") : dirname(binary);
const checkOnly = process.argv.includes("--check");

if (process.platform === "linux") {
  console.log("vmp-sign: Linux needs no VMP signature; nothing to do.");
  process.exit(0);
}
if (!existsSync(dist) || !statSync(dist).isDirectory()) {
  console.error(`vmp-sign: Electron distribution not found at ${dist}. Run pnpm install first.`);
  process.exit(1);
}

// Prefer a dedicated venv (Homebrew Python refuses global pip installs):
//   python3 -m venv ~/.local/share/cadence/evs-venv
//   ~/.local/share/cadence/evs-venv/bin/python -m pip install castlabs-evs
// CADENCE_EVS_PYTHON overrides it.
const venvPython = join(homedir(), ".local/share/cadence/evs-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python =
  process.env.CADENCE_EVS_PYTHON ?? (existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3");
const run = (args) => spawnSync(python, ["-m", ...args], { stdio: "inherit" });
const hasEvs = spawnSync(python, ["-c", "import castlabs_evs"], { stdio: "ignore" }).status === 0;
if (!hasEvs) {
  console.error(
    "vmp-sign: the Castlabs EVS client is not installed. One-time setup:\n" +
      `  ${python} -m pip install --upgrade castlabs-evs\n` +
      `  ${python} -m castlabs_evs.account signup   (or: account reauth)`,
  );
  process.exit(1);
}

console.log(`vmp-sign: ${checkOnly ? "verifying" : "signing"} ${dist}`);
const result = run(["castlabs_evs.vmp", checkOnly ? "verify-pkg" : "sign-pkg", dist]);
if (result.status !== 0) {
  console.error(
    checkOnly
      ? "vmp-sign: this Electron has no production VMP signature — DRM providers will be refused licenses."
      : "vmp-sign: signing failed. If EVS asked you to log in, run account reauth and try again.",
  );
  process.exit(result.status ?? 1);
}
console.log(checkOnly ? "vmp-sign: signature valid." : "vmp-sign: done. Restart Cadence to use the signed build.");
