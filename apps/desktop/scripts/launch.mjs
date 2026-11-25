import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const env = { ...process.env };
// These settings belong to a parent Electron app, not to Cadence.
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_DESKTOP;

/**
 * macOS names the Dock icon and the menu bar after the app bundle, not
 * app.setName, so unpackaged runs showed "Electron". Run a clone of
 * Electron.app named Cadence instead, rebuilt when Electron changes.
 * Any failure falls back to stock Electron: the name is not worth a
 * broken launch.
 */
function electronBinary() {
  const stock = require("electron");
  if (process.platform !== "darwin") return stock;
  const source = resolve(stock, "../../..");
  const cache = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache", "cadence-dev");
  const bundle = join(cache, "Cadence.app");
  const binary = join(bundle, "Contents", "MacOS", "Electron");
  const stampFile = join(cache, "source");
  try {
    // `pnpm vmp:sign` rewrites only the framework's .sig, so it is part of
    // the stamp: signing Electron after a clone exists refreshes the clone.
    const vmpSig = join(source, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Electron Framework.sig");
    const sigStamp = existsSync(vmpSig) ? statSync(vmpSig).mtimeMs : "none";
    const stamp = `${source}\n${statSync(join(source, "Contents", "Info.plist")).mtimeMs}\n${sigStamp}`;
    if (!existsSync(binary) || !existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
      // The stamp marks a finished clone, so a failed rebuild is retried.
      rmSync(stampFile, { force: true });
      rmSync(bundle, { recursive: true, force: true });
      mkdirSync(cache, { recursive: true });
      // -c clones on APFS, so the copy takes no time or space; cp falls
      // back to a plain copy where cloning is unsupported.
      execFileSync("cp", ["-cR", source, bundle], { stdio: "ignore" });
      const plist = join(bundle, "Contents", "Info.plist");
      const set = (key, value) => execFileSync("plutil", ["-replace", key, "-string", value, plist]);
      set("CFBundleName", "Cadence");
      set("CFBundleDisplayName", "Cadence");
      set("CFBundleIdentifier", "dev.cadence.player.dev");
      // The edited plist and identifier void Electron's ad-hoc signature.
      execFileSync("codesign", ["--force", "--sign", "-", "--preserve-metadata=entitlements,flags,runtime", bundle], { stdio: "ignore" });
      writeFileSync(stampFile, stamp);
    }
    return binary;
  } catch (error) {
    console.warn(`[launch] running stock Electron; could not prepare Cadence.app: ${error.message}`);
    return stock;
  }
}

const child = spawn(electronBinary(), [".", ...process.argv.slice(2)], { env, stdio: "inherit" });
let shutdownTimer;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shutdownTimer) return;
    child.kill(signal);
    // If Electron cannot complete shutdown, do not leave playback behind.
    shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 4000);
    shutdownTimer.unref();
  });
}
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => { clearTimeout(shutdownTimer); process.exitCode = code ?? (signal ? 1 : 0); });
