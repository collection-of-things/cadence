import type { RouteErrorCode } from "@cadence/protocol";

/**
 * A route failure that already knows how the listener should see it: a
 * user-facing message (no "play failed:" prefix needed), whether trying the
 * same thing again can help, and an optional machine code the UI acts on.
 *
 * Adapters reject with it; the coordinator reports it once. See the error
 * ownership note on RouteAdapter.
 */
export class RouteError extends Error {
  readonly retriable: boolean;
  readonly code: RouteErrorCode | undefined;

  constructor(message: string, opts: { retriable: boolean; code?: RouteErrorCode }) {
    super(message);
    this.name = "RouteError";
    this.retriable = opts.retriable;
    this.code = opts.code;
  }
}

/** The route needs a signed-in account before it can play. */
export function signInRequired(message: string): RouteError {
  return new RouteError(message, { retriable: false, code: "unauthenticated" });
}
