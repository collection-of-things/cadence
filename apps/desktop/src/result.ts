/**
 * Small tagged Result for expected failures — used where a caller must
 * handle a known error rather than catch a rejection.
 */
export type Result<T, E> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: E };

/** Wrap a success value. */
export function ok<T>(value: T): Result<T, never> {
  return { _tag: "ok", value };
}

/** Wrap an expected failure. */
export function err<E>(error: E): Result<never, E> {
  return { _tag: "err", error };
}

/** True when the result carries a value. */
export function isOk<T, E>(r: Result<T, E>): r is { readonly _tag: "ok"; readonly value: T } {
  return r._tag === "ok";
}
