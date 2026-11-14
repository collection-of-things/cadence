import type { QueueItem, RouteAdapter } from "@cadence/protocol";

/**
 * Optional capabilities an adapter may implement beyond the RouteAdapter
 * contract. Checked structurally at the call site — the contract is fixed by
 * @cadence/protocol, so extras live behind narrow ports.
 */

/** Adapters that can reload a queue item paused after an engine restart. */
export interface RestartRestorable {
  /**
   * Re-load an item paused at `positionMs` without starting playback. Used
   * when the underlying engine process restarted underneath the route.
   */
  restoreAfterEngineRestart(item: QueueItem, positionMs: number): Promise<void>;
}

/** True when the adapter supports paused restore after an engine restart. */
export function isRestartRestorable(a: RouteAdapter): a is RouteAdapter & RestartRestorable {
  return "restoreAfterEngineRestart" in a && typeof a.restoreAfterEngineRestart === "function";
}

/** Adapters whose engine supports the strict local fidelity (DSP bypass) toggle. */
export interface FidelityCapable {
  /** Enable or disable strict fidelity mode on the route's engine. */
  setFidelityMode(enabled: boolean): Promise<void>;
}

/** True when the adapter supports the fidelity-mode toggle. */
export function isFidelityCapable(a: RouteAdapter): a is RouteAdapter & FidelityCapable {
  return "setFidelityMode" in a && typeof a.setFidelityMode === "function";
}

/** Adapters whose engine can apply per-track ReplayGain on request. */
export interface ReplayGainCapable {
  /** Enable or disable ReplayGain application on the route's engine. */
  setReplayGain(enabled: boolean): Promise<void>;
}

/** True when the adapter supports the ReplayGain toggle. */
export function isReplayGainCapable(a: RouteAdapter): a is RouteAdapter & ReplayGainCapable {
  return "setReplayGain" in a && typeof a.setReplayGain === "function";
}

/** Routes that run their own EQ outside the Rust engine (Apple's page graph). */
export interface EqCapable {
  /** Apply the engine's band list; gains in dB, peaking filters at Q 1. */
  setEq(bands: readonly { freqHz: number; gainDb: number }[]): Promise<void>;
}

/** True when the adapter applies EQ itself. */
export function isEqCapable(a: RouteAdapter): a is RouteAdapter & EqCapable {
  return "setEq" in a && typeof a.setEq === "function";
}
