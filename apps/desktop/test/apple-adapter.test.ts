/**
 * AppleMusicKitAdapter event/queue logic with a faked ProviderSession —
 * covers the council-flagged paths without a live music.apple.com.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AppleMusicKitAdapter } from "../src/adapters/providers/apple-musickit.js";
import { ProviderEvalTimeout } from "../src/adapters/providers/provider-session.js";
import type { AdapterEvent, QueueItem } from "@cadence/protocol";

/** Minimal fake — captures evals, lets the test fire page events. */
class FakeSession {
  evals: string[] = [];
  onEvent?: (e: { name: string; data: unknown }) => void;
  constructor(public alive = true) {}
  async eval(expr: string): Promise<unknown> {
    this.evals.push(expr);
    return true;
  }
  async prepare(): Promise<void> {}
  setAudioMuted(): void {}
  async reset(): Promise<void> {
    this.alive = false;
  }
  async clearData(): Promise<void> {}
  async hasSessionCookies(): Promise<boolean> {
    return false;
  }
  hide(): void {}
  reveal(): void {}
  popupCloseHandlers: Array<() => void> = [];
  onPopupClosed(cb: () => void): () => void {
    this.popupCloseHandlers.push(cb);
    return () => {
      this.popupCloseHandlers = this.popupCloseHandlers.filter((h) => h !== cb);
    };
  }
  /** Test hook: pretend the sign-in popup window just closed. */
  closePopup(): void {
    for (const h of [...this.popupCloseHandlers]) h();
  }
  hasOpenPopups = false;
  emit(name: string, data: unknown): void {
    this.onEvent?.({ name, data });
  }
}

function makeAdapter() {
  const adapter = new AppleMusicKitAdapter();
  const sess = new FakeSession();
  const events: AdapterEvent[] = [];
  // Wire the fake: replace session + record emitted events.
  (adapter as any).session = sess;
  (adapter as any).installed = true;
  sess.onEvent = (e) => (adapter as any).onPageEvent(e.name, e.data);
  adapter.onEvent((e) => events.push(e));
  return { adapter, sess, events };
}

const track = (id: string, uri?: string) =>
  ({
    id: `apple-musickit:${id}`,
    route: "apple-musickit",
    provider: "apple",
    title: id,
    artists: [],
    durationMs: 200_000,
    source: { kind: "provider", providerItemId: id, uri },
    availability: "available",
  }) as unknown as QueueItem["track"];

const item = (queueId: string, id: string, uri?: string): QueueItem =>
  ({ queueId, track: track(id, uri) }) as QueueItem;

describe("apple adapter page events", () => {
  let adapter: AppleMusicKitAdapter;
  let sess: FakeSession;
  let events: AdapterEvent[];

  beforeEach(() => {
    const m = makeAdapter();
    adapter = m.adapter;
    sess = m.sess;
    events = m.events;
  });

  it("ignores station ended/nowPlaying changes inside a stream", () => {
    (adapter as any).current = { queueId: "q1", providerId: "st1", station: true };
    sess.emit("playerState", { state: "ended", ended: true, isAuthorized: true, positionMs: 0 });
    sess.emit("nowPlaying", { id: "song-in-stream-1" });
    sess.emit("nowPlaying", { id: "song-in-stream-2" });
    expect(events.filter((e) => e.kind === "ended")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "started")).toHaveLength(0);
  });

  it("ended on a real track emits ended; transient stopped does not", () => {
    (adapter as any).current = { queueId: "q1", providerId: "s1", station: false };
    sess.emit("playerState", { state: "stopped", ended: false, isAuthorized: true, positionMs: 0 });
    expect(events.filter((e) => e.kind === "ended")).toHaveLength(0);
    sess.emit("playerState", { state: "ended", ended: true, isAuthorized: true, positionMs: 0 });
    const ended = events.filter((e) => e.kind === "ended");
    expect(ended).toHaveLength(1);
    expect((ended[0] as { queueId?: string }).queueId).toBe("q1");
  });

  it("unknown nowPlaying needs two sightings before ended + pause", () => {
    (adapter as any).current = { queueId: "q1", providerId: "s1", station: false };
    (adapter as any).mirrored = [{ queueId: "q2", providerId: "s2", station: false }];
    sess.emit("nowPlaying", { id: "ghost-item" });
    // First sighting: hold — a transient boundary id must not kill the lease.
    expect(events.filter((e) => e.kind === "ended")).toHaveLength(0);
    sess.emit("nowPlaying", { id: "ghost-item" });
    expect(events.some((e) => e.kind === "ended" && (e as { queueId?: string }).queueId === "q1")).toBe(true);
    expect(sess.evals.some((e) => e.includes("pause()"))).toBe(true);
  });

  it("mirrored successor promotion emits ended+started", () => {
    (adapter as any).current = { queueId: "q1", providerId: "s1", station: false };
    (adapter as any).mirrored = [{ queueId: "q2", providerId: "s2", station: false }];
    sess.emit("nowPlaying", { id: "s2" });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("ended");
    expect(kinds).toContain("started");
    const started = events.find((e) => e.kind === "started") as { queueId?: string };
    expect(started.queueId).toBe("q2");
    expect((adapter as any).current.queueId).toBe("q2");
  });

  it("forged/malformed events are dropped", () => {
    (adapter as any).current = { queueId: "q1", providerId: "s1", station: false };
    sess.emit("playerState", null);
    sess.emit("nowPlaying", null);
    sess.emit("playerState", { ended: true }); // no state field — not a real playerState
    expect(events.filter((e) => e.kind === "ended")).toHaveLength(0);
    sess.emit("evilEvent", { id: "x" });
    expect(events.filter((e) => e.kind === "ended")).toHaveLength(0);
  });

  it("same song at a new queue position promotes the duplicate mirror", () => {
    (adapter as any).current = { queueId: "q1", providerId: "s1", station: false };
    (adapter as any).mirrored = [{ queueId: "q2", providerId: "s1", station: false }];
    sess.emit("nowPlaying", { id: "s1", queuePos: 1 });
    const started = events.find((e) => e.kind === "started") as { queueId?: string };
    expect(started?.queueId).toBe("q2");
    // Without queuePos there's no way to tell a replay from a promotion.
    (adapter as any).mirrored = [{ queueId: "q3", providerId: "s1", station: false }];
    const before = events.length;
    sess.emit("nowPlaying", { id: "s1" });
    expect(events.length).toBe(before);
  });

  it("prefetch never mirrors stations", async () => {
    await adapter.prefetch(item("q2", "ra1", "am:station:ra1"));
    expect(sess.evals.some((e) => e.includes("playLater"))).toBe(false);
    expect((adapter as any).mirrored).toHaveLength(0);
  });

  it("prefetch clears a replaced successor before mirroring", async () => {
    (adapter as any).mirrored = [{ queueId: "qA", providerId: "sA", station: false }];
    await adapter.prefetch(item("qB", "sB"));
    expect(sess.evals.some((e) => e.includes("clearPlayLater()"))).toBe(true);
    expect((adapter as any).mirrored[0]?.providerId).toBe("sB");
  });

  it("prefetch re-points a same-song mirror at the new queueId", async () => {
    (adapter as any).mirrored = [{ queueId: "q1", providerId: "sB", station: false }];
    await adapter.prefetch(item("q2", "sB"));
    expect(sess.evals.some((e) => e.includes("playLater"))).toBe(false);
    expect((adapter as any).mirrored[0]?.queueId).toBe("q2");
  });

  it("prefetch skips mirroring while a station is playing", async () => {
    (adapter as any).current = { queueId: "qSt", providerId: "ra1", station: true };
    await adapter.prefetch(item("q2", "sB"));
    expect(sess.evals.some((e) => e.includes("playLater"))).toBe(false);
    expect((adapter as any).mirrored).toHaveLength(0);
  });

  it("prefetch to a station still clears the previous mirror", async () => {
    (adapter as any).mirrored = [{ queueId: "qA", providerId: "sA", station: false }];
    await adapter.prefetch(item("qSt", "ra1", "am:station:ra1"));
    expect(sess.evals.some((e) => e.includes("clearPlayLater()"))).toBe(true);
    expect(sess.evals.some((e) => e.includes("playLater"))).toBe(false);
    expect((adapter as any).mirrored).toHaveLength(0);
  });

  it("a mirrored next uses skipTo, not a stream reload", async () => {
    (adapter as any).current = { queueId: "q1", providerId: "sA", station: false };
    (adapter as any).mirrored = [{ queueId: "q2", providerId: "sB", station: false }];
    await adapter.play(item("q2", "sB"), { generationId: 3, route: "apple-musickit", queueId: "q2", issuedAtMs: 0 }, { positionMs: 0 });
    expect(sess.evals.some((e) => e.includes("skipTo"))).toBe(true);
    expect(sess.evals.some((e) => e.includes("__cadenceCtl.play("))).toBe(false);
    expect(events.some((e) => e.kind === "started")).toBe(true);
  });

  it("a prefetch queued behind play() lands after it", async () => {
    (adapter as any).current = { queueId: "q1", providerId: "sA", station: false };
    const play = adapter.play(item("q2", "sB"), { generationId: 3, route: "apple-musickit", queueId: "q2", issuedAtMs: 0 }, { positionMs: 0 });
    const pre = adapter.prefetch(item("q3", "sC"));
    await Promise.all([play, pre]);
    // play's eval must precede prefetch's playLater.
    const playIdx = sess.evals.findIndex((e) => e.includes("__cadenceCtl.play(") || e.includes("skipTo"));
    const plIdx = sess.evals.findIndex((e) => e.includes("playLater"));
    expect(playIdx).toBeGreaterThanOrEqual(0);
    expect(plIdx).toBeGreaterThan(playIdx);
  });

  it("sign-out drops a queued play and emits stopped", async () => {
    (adapter as any).current = { queueId: "q1", providerId: "sA", station: false };
    // Hold the chain with a slow prefetch, queue a play behind it, then sign out.
    const origEval = sess.eval.bind(sess);
    let release!: () => void;
    (sess as any).eval = (expr: string) => {
      sess.evals.push(expr);
      return expr.includes("clearPlayLater")
        ? new Promise((r) => { release = () => r(true); })
        : Promise.resolve(true);
    };
    (adapter as any).mirrored = [{ queueId: "qB", providerId: "sB", station: false }];
    const pre = adapter.prefetch(item("q3", "sC")); // slow clearPlayLater holds the chain
    const play = adapter.play(item("q2", "sB"), { generationId: 3, route: "apple-musickit", queueId: "q2", issuedAtMs: 0 }, { positionMs: 0 });
    await adapter.signOut();
    expect(events.some((e) => e.kind === "stopped")).toBe(true);
    release();
    await expect(play).rejects.toThrow(/signed out/);
    (sess as any).eval = origEval;
    await pre.catch(() => {});
    expect(sess.evals.some((e) => e.includes("skipTo") || e.includes("__cadenceCtl.play("))).toBe(false);
  });

  it("signIn calls MusicKit authorize() and hides when already authorized", async () => {
    (adapter as any).authorized = true;
    await adapter.signIn();
    expect(sess.evals.some((e) => e.includes("authorize()"))).toBe(false);
    (adapter as any).authorized = false;
    await adapter.signIn();
    expect(sess.evals.some((e) => e.includes("authorize()"))).toBe(true);
  });

  it("signIn falls back to the DOM click when authorize() rejects", async () => {
    const orig = sess.eval.bind(sess);
    (sess as any).eval = (expr: string) => {
      sess.evals.push(expr);
      return expr.includes("authorize()") ? Promise.reject(new Error("nope")) : Promise.resolve(true);
    };
    await adapter.signIn();
    expect(sess.evals.some((e) => e.includes("clickSignIn()"))).toBe(true);
    (sess as any).eval = orig;
  });

  it("capabilities() reports unauthenticated when not installed, ready after authorization", async () => {
    const caps = await adapter.capabilities();
    expect(caps.state).toBe("unauthenticated");
    (adapter as any).installed = true;
    (adapter as any).authorized = true;
    const caps2 = await adapter.capabilities();
    expect(caps2.state).toBe("ready");
  });

  it("signIn throws when neither authorize() nor the fallback can open auth", async () => {
    const orig = sess.eval.bind(sess);
    (sess as any).eval = (expr: string) => {
      sess.evals.push(expr);
      if (expr.includes("authorize()")) return Promise.reject(new Error("dead"));
      if (expr.includes("clickSignIn()")) return Promise.resolve(false);
      return Promise.resolve(true);
    };
    await expect(adapter.signIn()).rejects.toThrow(/couldn't open/);
    (sess as any).eval = orig;
  });

  it("a timed-out authorize() does not hide the window (popup may still be open)", async () => {
    const orig = sess.eval.bind(sess);
    let hideCount = 0;
    (sess as any).hide = () => { hideCount++; };
    (sess as any).eval = (expr: string) => {
      sess.evals.push(expr);
      return expr.includes("authorize()") ? Promise.reject(new ProviderEvalTimeout("test")) : Promise.resolve(true);
    };
    await adapter.signIn();
    await new Promise((r) => setTimeout(r, 20));
    expect(hideCount).toBe(0);
    (sess as any).eval = orig;
  });

  it("a second signIn click while a flow is live reveals instead of stacking", async () => {
    const orig = sess.eval.bind(sess);
    (sess as any).eval = (expr: string) => {
      sess.evals.push(expr);
      // authorize() stays pending — the popup is open, user typing.
      return expr.includes("authorize()") ? new Promise<boolean>(() => {}) : Promise.resolve(true);
    };
    await adapter.signIn();
    const authCalls = sess.evals.filter((e) => e.includes("authorize()")).length;
    await adapter.signIn(); // second click — must not stack another authorize()
    expect(sess.evals.filter((e) => e.includes("authorize()")).length).toBe(authCalls);
    (sess as any).eval = orig;
  });

  it("popup close without auth ends the attempt and hides the window", async () => {
    const orig = sess.eval.bind(sess);
    let hides = 0;
    (sess as any).hide = () => hides++;
    (sess as any).eval = (expr: string) => {
      sess.evals.push(expr);
      return expr.includes("authorize()") ? new Promise<boolean>(() => {}) : Promise.resolve(true);
    };
    await adapter.signIn();
    sess.closePopup();
    expect(hides).toBe(1);
    expect((adapter as any).signInPending).toBe(false);
    (sess as any).eval = orig;
  });
});
