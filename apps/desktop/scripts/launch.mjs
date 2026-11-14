import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const env = { ...process.env };
// These settings belong to a parent Electron app, not to Cadence.
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_DESKTOP;

const child = spawn(require("electron"), [".", ...process.argv.slice(2)], { env, stdio: "inherit" });
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
