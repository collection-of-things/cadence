import { describe, expect, it } from "vitest";
import { SimulatedClock, createActor, initialTransition, transition } from "xstate";
import { PROMOTION_WINDOW_MS, trackBoundaryMachine } from "../src/coordinator/track-boundary.js";

const ended = (over: Partial<{ endedQid: string; generationId: number; hasSuccessor: boolean }> = {}) => {
  const generationId = over.generationId ?? 1;
  const endedQid = over.endedQid ?? "q1";
  return {
    type: "engine.ended" as const,
    reportedQid: endedQid,
    generationId,
    endedQid,
    hasSuccessor: over.hasSuccessor ?? true,
  };
};

/** Start an actor on a simulated clock and record every emitted event. */
function harness() {
  const clock = new SimulatedClock();
  const actor = createActor(trackBoundaryMachine, { clock }).start();
  const out: string[] = [];
  actor.on("*", (e) => out.push(e.type));
  return { clock, actor, out };
}

describe("track boundary machine (pure transitions)", () => {
  it("schedules the promotion window only when a prefetch is installed", () => {
    const [s0] = initialTransition(trackBoundaryMachine);
    const [direct, directEffects] = transition(trackBoundaryMachine, s0, ended());
    expect(direct.value).toBe("listening");
    expect(directEffects.map((a) => a.type)).toEqual(["track.ended", "advance.now"]);

    const [primed] = transition(trackBoundaryMachine, s0, { type: "prefetch.installed", queueId: "q2" });
    const [waiting, effects] = transition(trackBoundaryMachine, primed, ended());
    expect(waiting.value).toBe("awaitingPromotion");
    expect(effects.map((a) => a.type)).toEqual(["track.ended", "@xstate.raise"]);
    expect(effects[1]).toMatchObject({ delay: PROMOTION_WINDOW_MS });
  });

  it("ends the session without advancing when nothing follows", () => {
    const [s0] = initialTransition(trackBoundaryMachine);
    const [, effects] = transition(trackBoundaryMachine, s0, ended({ hasSuccessor: false }));
    expect(effects.map((a) => a.type)).toEqual(["track.ended", "session.end"]);
  });
});

describe("track boundary machine (actor on a simulated clock)", () => {
  it("acts on each generation:queueId once until a lease commits", () => {
    const { actor, out } = harness();
    actor.send(ended());
    actor.send(ended());
    expect(out).toEqual(["track.ended", "advance.now"]);
    actor.send({ type: "lease.committed" });
    actor.send(ended());
    expect(out).toEqual(["track.ended", "advance.now", "track.ended", "advance.now"]);
  });

  it("drives the advance itself when the window passes without a promotion", () => {
    const { actor, clock, out } = harness();
    actor.send({ type: "prefetch.installed", queueId: "q2" });
    actor.send(ended());
    clock.increment(PROMOTION_WINDOW_MS - 1);
    expect(out).toEqual(["track.ended"]);
    clock.increment(1);
    expect(out).toEqual(["track.ended", "advance.afterWindow"]);
    expect(actor.getSnapshot().context.prefetchQid).toBeNull();
  });

  it.each(["engine.promoted", "handoff.begin", "session.torndown"] as const)(
    "%s closes the window so no advance follows",
    (type) => {
      const { actor, clock, out } = harness();
      actor.send({ type: "prefetch.installed", queueId: "q2" });
      actor.send(ended());
      actor.send({ type });
      clock.increment(PROMOTION_WINDOW_MS * 2);
      expect(out).toEqual(["track.ended"]);
      expect(actor.getSnapshot().matches("listening")).toBe(true);
      expect(actor.getSnapshot().context.prefetchQid).toBeNull();
    },
  );

  it("a second end inside the window keeps the first window", () => {
    const { actor, clock } = harness();
    const fired: string[] = [];
    actor.on("advance.afterWindow", (e) => fired.push(e.endedQid));
    actor.send({ type: "prefetch.installed", queueId: "q2" });
    actor.send(ended({ endedQid: "q1" }));
    clock.increment(400);
    actor.send(ended({ endedQid: "q2" }));
    clock.increment(PROMOTION_WINDOW_MS - 400);
    expect(fired).toEqual(["q1"]);
    clock.increment(PROMOTION_WINDOW_MS * 2);
    expect(fired).toEqual(["q1"]);
  });

  it("dropping the prefetch keeps an open window running", () => {
    const { actor, clock, out } = harness();
    actor.send({ type: "prefetch.installed", queueId: "q2" });
    actor.send(ended());
    actor.send({ type: "prefetch.dropped" });
    clock.increment(PROMOTION_WINDOW_MS);
    expect(out).toEqual(["track.ended", "advance.afterWindow"]);
  });
});
