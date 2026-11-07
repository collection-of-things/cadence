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

export async function startXvfb({ width = 1440, height = 900, persistent = false, onProc = null, aborted = null } = {}) {
  const isAborted = () => aborted?.() ?? false;
  for (let n = 90; n < 120; n++) {
    // an interrupt during a previous iteration must STOP this loop —
    // retrying would spawn an Xvfb nobody tracks anymore
    if (isAborted()) throw new Error("Xvfb launch aborted");
    if (!(await displayFree(n))) continue;
    const proc = spawn("Xvfb", [`:${n}`, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], {
      stdio: "ignore",
      detached: persistent,
    });
    if (persistent) proc.unref();
    proc.on("exit", () => {}); // always reap — no zombie window
    // register the spawned process AT SPAWN TIME — an interrupt landing
    // inside the readiness wait below must still find it killable.
    // stop() AWAITS exit so teardown can't exit before the X server dies.
    const handle = {
      display: `:${n}`,
      proc,
      stop: async () => {
        try { proc.kill("SIGTERM"); } catch { return; }
        const deadline = Date.now() + 2_000;
        while (proc.exitCode === null && Date.now() < deadline) await sleep(50);
        if (proc.exitCode === null) {
          try { proc.kill("SIGKILL"); } catch {}
          const kdeadline = Date.now() + 1_000;
          while (proc.exitCode === null && Date.now() < kdeadline) await sleep(50);
        }
      },
    };
    onProc?.(handle);
    // wait for the socket to appear
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (isAborted()) throw new Error("Xvfb launch aborted");
      if (existsSync(`/tmp/.X11-unix/X${n}`)) {
        // socket is not proof of life — Xvfb can die right after binding
        // (keymap failure, tmpfs pressure). Confirm it's still running.
        await sleep(250);
        if (proc.exitCode === null) return handle;
      }
      if (proc.exitCode !== null) break;
      await sleep(100);
    }
    if (isAborted()) throw new Error("Xvfb launch aborted");
    try { proc.kill("SIGKILL"); } catch {}
  }
  throw new Error("no free X display for Xvfb (looked in :90-:119)");
}
