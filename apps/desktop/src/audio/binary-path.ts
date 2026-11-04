import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the cadence-audio binary:
 *   1. `CADENCE_AUDIO_BIN` env var (explicit override)
 *   2. `resourcesPath/audio/{platform}-{arch}/cadence-audio` (packaged app)
 *   3. `target/{debug,release}/cadence-audio` (cargo workspace-root dev build)
 *   4. `services/audio/target/{debug,release}/` (standalone crate layout)
 * Returns null when nothing exists — the caller decides how to degrade.
 */
export function resolveAudioBinary(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  resourcesPath?: string,
): string | null {
  const fromEnv = env.CADENCE_AUDIO_BIN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const exe = process.platform === "win32" ? "cadence-audio.exe" : "cadence-audio";
  if (resourcesPath !== undefined) {
    const triple = `${process.platform}-${process.arch}`;
    const candidates = [
      join(resourcesPath, "audio", triple, exe),
      join(resourcesPath, "audio", exe),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  for (const profile of ["debug", "release"]) {
    for (const base of [
      join(repoRoot, "target", profile, exe),
      join(repoRoot, "services", "audio", "target", profile, exe),
    ]) {
      if (existsSync(base)) return base;
    }
  }
  return null;
}
