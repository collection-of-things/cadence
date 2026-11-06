// xvfb.mjs — a private X display so nothing ever reaches the user's screen.
// Each session gets its own Xvfb on a free display number; the server is
// killed with the session. Never run the app on the user's real DISPLAY.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { sleep } from "./env.mjs";

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Drop the lock+socket of a dead Xvfb — crashed runs leak them and would
 * otherwise exhaust the display range over repeated runs. */
function sweepStale(n) {
  const lock = `/tmp/.X${n}-lock`;
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, "utf8").trim());
  if (pidAlive(pid)) return;
  try { rmSync(lock); } catch {}
  try { rmSync(`/tmp/.X11-unix/X${n}`); } catch {}
}

async function displayFree(n) {
  sweepStale(n);
  // Xvfb grabs /tmp/.X11-unix/X<n>; absence of the socket means free.
  return !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`);
}

export async function startXvfb({ width = 1440, height = 900, persistent = false } = {}) {
  for (let n = 90; n < 120; n++) {
    if (!(await displayFree(n))) continue;
    const proc = spawn("Xvfb", [`:${n}`, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], {
      stdio: "ignore",
      detached: persistent,
    });
    if (persistent) proc.unref();
    // wait for the socket to appear
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (existsSync(`/tmp/.X11-unix/X${n}`)) {
        // socket is not proof of life — Xvfb can die right after binding
        // (keymap failure, tmpfs pressure). Confirm it's still running.
        await sleep(250);
        if (proc.exitCode === null) {
          proc.on("exit", () => {});
          return { display: `:${n}`, proc, stop: () => proc.kill("SIGTERM") };
        }
      }
      if (proc.exitCode !== null) break;
      await sleep(100);
    }
    try { proc.kill("SIGKILL"); } catch {}
  }
  throw new Error("no free X display for Xvfb (looked in :90-:119)");
}
