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
