import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the cadence-audio binary:
 *   1. `CADENCE_AUDIO_BIN` env var (explicit override, packaged builds)
 *   2. `services/audio/target/debug/cadence-audio` relative to repo root
 *   3. `services/audio/target/release/cadence-audio`
 * Returns null when nothing exists — the caller decides how to degrade.
 */
export function resolveAudioBinary(env: NodeJS.ProcessEnv, repoRoot: string): string | null {
  const fromEnv = env.CADENCE_AUDIO_BIN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const exe = process.platform === "win32" ? "cadence-audio.exe" : "cadence-audio";
  for (const profile of ["debug", "release"]) {
    const candidate = join(repoRoot, "services", "audio", "target", profile, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
