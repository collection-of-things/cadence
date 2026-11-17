import { createActor, setup, types } from "xstate";

/**
 * Track-boundary decisions for the coordinator, as an XState v6 machine.
 *
 * It owns:
 *   - `prefetchQid`: the successor the active engine was asked to prefetch.
 *   - `handledEnded`: `${generation}:${queueId}` keys already acted on, reset
 *     when a lease commits.
 *   - the promotion window: after an `ended` with a prefetch installed, wait
 *     600ms for the engine's own `started` before driving the advance. The
 *     window is the `awaitingPromotion` state; leaving it cancels the timer.
 *
 * Transitions are pure. The coordinator gates events by lease, resolves
 * queue facts, sends them here, and reacts to the emitted decisions.
 */

/** Delay before the coordinator drives an advance itself. */
export const PROMOTION_WINDOW_MS = 600;

interface EndedFacts {
  /** Generation of the lease the `ended` passed the gate for. */
  readonly generationId: number;
  /** Item that ended, resolved against the queue. */
  readonly endedQid: string;
}

type Empty = Record<never, never>;

export const trackBoundaryMachine = setup({
  schemas: {
    context: types<{
      prefetchQid: string | null;
      handledEnded: readonly string[];
    }>(),
    events: {
      /** startItem began: any wait or prefetch belief is void. */
      "handoff.begin": types<Empty>(),
      /** A new lease committed: earlier `ended` keys can't recur. */
      "lease.committed": types<Empty>(),
      /** Playback session torn down (stop, teardown, provider `stopped`). */
      "session.torndown": types<Empty>(),
      "prefetch.installed": types<{ queueId: string }>(),
      "prefetch.dropped": types<Empty>(),
      /** The engine self-promoted into its prefetch. */
      "engine.promoted": types<Empty>(),
      "engine.ended": types<
        EndedFacts & {
          /** Event queueId with the lease fallback, for `trackEnded`. */
          readonly reportedQid: string;
          /** The ended item has a successor in the queue right now. */
          readonly hasSuccessor: boolean;
        }
      >(),
    },
    emitted: {
      /** Tell listeners a track ended (first time per key). */
      "track.ended": types<{ queueId: string; generationId: number }>(),
      /** No successor: the session stops. */
      "session.end": types<Empty>(),
      /** Advance past the ended item now. */
      "advance.now": types<EndedFacts>(),
      /** The window passed without a self-promotion. */
      "advance.afterWindow": types<EndedFacts>(),
    },
  },
  states: {
    listening: {},
    awaitingPromotion: { schemas: { input: types<EndedFacts>() } },
  },
}).createMachine({
  id: "trackBoundary",
  context: { prefetchQid: null, handledEnded: [] },
  initial: "listening",
  on: {
    "handoff.begin": { target: ".listening", context: { prefetchQid: null } },
    "session.torndown": { target: ".listening", context: { prefetchQid: null } },
    "lease.committed": { context: { handledEnded: [] } },
    "prefetch.installed": ({ event }) => ({ context: { prefetchQid: event.queueId } }),
    "prefetch.dropped": { context: { prefetchQid: null } },
    "engine.promoted": { target: ".listening", context: { prefetchQid: null } },
    "engine.ended": ({ context, event, self }, enq) => {
      const key = `${event.generationId}:${event.reportedQid}`;
      if (context.handledEnded.includes(key)) return;
      const handledEnded = [...context.handledEnded, key];
      enq.emit({
        type: "track.ended",
        queueId: event.reportedQid,
        generationId: event.generationId,
      });
      const facts = { generationId: event.generationId, endedQid: event.endedQid };
      if (!event.hasSuccessor) {
        enq.emit({ type: "session.end" });
        return { context: { handledEnded } };
      }
      // An open window keeps its first input and deadline: the lease still
      // names that item, so its advance is the one that can pass. Targeting
      // the child from this root handler would exit and re-enter it, even
      // without `reenter`, replacing the input and restarting the timer.
      if (self.getSnapshot().matches("awaitingPromotion")) {
        return { context: { handledEnded } };
      }
      if (context.prefetchQid !== null) {
        // The engine may promote its prefetch itself; give it the window.
        return { target: ".awaitingPromotion", input: facts, context: { handledEnded } };
      }
      enq.emit({ type: "advance.now", ...facts });
      return { context: { handledEnded } };
    },
  },
  states: {
    listening: {},
    awaitingPromotion: {
      timeout: PROMOTION_WINDOW_MS,
      onTimeout: ({ input }, enq) => {
        enq.emit({
          type: "advance.afterWindow",
          generationId: input.generationId,
          endedQid: input.endedQid,
        });
        return { target: "listening", context: { prefetchQid: null } };
      },
    },
  },
});

export function createTrackBoundary() {
  return createActor(trackBoundaryMachine).start();
}

export type TrackBoundary = ReturnType<typeof createTrackBoundary>;
