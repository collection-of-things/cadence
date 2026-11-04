import type {
  ActiveOutput,
  AdapterEvent,
  AudioRpcEvent,
  CoordinatorEvent,
  PlaybackCommand,
  PlaybackLease,
  PlaybackSnapshot,
  PlaybackStatus,
  QueueItem,
  QueueState,
  RouteAdapter,
  RouteCapabilities,
  RouteId,
} from "@cadence/protocol";
import type { AdapterRegistry } from "../adapters/registry.js";
import { isFidelityCapable, isRestartRestorable } from "../adapters/types.js";
import { parsePersistedPlayback, type PersistedPlayback } from "./persisted-state.js";
import * as QueueOps from "./queue-ops.js";
import type { SettingsStore } from "./settings-store.js";

/**
 * Optional stream of raw audio-graph events (fft/output/position) shared by
 * every native-pcm route. In production this is the AudioServiceClient; the
 * local and librespot engines feed the same graph, so these events belong to
 * whichever generation holds the current lease.
 */
export interface GraphEventSource {
  /** Subscribe to raw audio-service events. */
  onEvent(cb: (e: AudioRpcEvent) => void): void;
}

/** Constructor dependencies for the Coordinator. */
export interface CoordinatorDeps {
  readonly registry: AdapterRegistry;
  readonly store: SettingsStore;
  /** Shared audio-graph event source (fft/output). Optional in tests. */
  readonly graphEvents?: GraphEventSource;
  readonly now?: () => number;
  /** Debounce for settings writes; 0 persists synchronously. */
  readonly persistDebounceMs?: number;
  /** Random source for shuffle order generation. */
  readonly rand?: () => number;
}

/**
 * The coordinator owns queue intent, playback leases, route handoff and
 * per-route volume memory. Route adapters only touch their own engine; all
 * authority over "what should be playing" lives here.
 *
 * Generation rule: every playback attempt issues a fresh PlaybackLease with a
 * monotonically increasing generationId. Adapter/engine events stamped with
 * an older generation are dropped, so a dying route cannot reclaim playback
 * after a handoff.
 */
export class Coordinator {
  private readonly registry: AdapterRegistry;
  private readonly store: SettingsStore;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly persistDebounceMs: number;
  private readonly listeners = new Set<(e: CoordinatorEvent) => void>();

  private queue: QueueState = QueueOps.emptyQueue();
  private lease: PlaybackLease | null = null;
  private generation = 0;
  private queueIdSeq = 0;
  private activeAdapter: RouteAdapter | null = null;
  private activeRouteValue: RouteId | null = null;
  private status: PlaybackStatus = "stopped";
  private positionMs = 0;
  private positionAtMs = 0;
  private durationMs = 0;
  private volume = 1;
  private muted = false;
  private fidelityMode = false;
  private readonly volumeByRoute = new Map<RouteId, number>();
  private output: ActiveOutput | null = null;
  private lastError: PlaybackSnapshot["lastError"];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Serializes commands and event-driven starts so handoffs can't overlap. */
  private chain: Promise<void> = Promise.resolve();
  /** queueId of the successor we asked the active adapter to prefetch. */
  private pendingPrefetch: string | null = null;
  /** Set after an engine `ended` while we wait for a self-promoted started. */
  private promotionTimer: ReturnType<typeof setTimeout> | null = null;
  /** ended events already handled, keyed `${generation}:${queueId}`. */
  private handledEnded = new Set<string>();
  /** queueId the engine self-promoted for the current lease (tail-race guard). */
  private promotedQueueId: string | null = null;

  constructor(deps: CoordinatorDeps) {
    this.registry = deps.registry;
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    this.rand = deps.rand ?? (() => Math.random());
    this.persistDebounceMs = deps.persistDebounceMs ?? 1_000;

    this.registry.subscribeAll((route, e) => {
      this.onAdapterEvent(route, e);
    });
    deps.graphEvents?.onEvent((e) => {
      this.onGraphEvent(e);
    });
    this.restoreFromSettings();
  }

  // --- subscriptions -------------------------------------------------------

  /** Subscribe to coordinator events. Returns an unsubscribe function. */
  onEvent(cb: (e: CoordinatorEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Current playback snapshot for `window.cadence.getSnapshot()`. */
  getSnapshot(): PlaybackSnapshot {
    return {
      status: this.status,
      lease: this.lease,
      current: QueueOps.currentItem(this.queue),
      positionMs: this.positionMs,
      positionAtMs: this.positionAtMs,
      durationMs: this.durationMs,
      volume: this.volume,
      muted: this.muted,
      fidelityMode: this.fidelityMode,
      ...(this.output !== null ? { output: this.output } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  /** Current queue state for `window.cadence.getQueue()`. */
  getQueue(): QueueState {
    return this.queue;
  }

  /** The route currently holding the lease, for restart/restore decisions. */
  get activeRoute(): RouteId | null {
    return this.activeRouteValue;
  }

  /** Capability fan-in across all registered route adapters. */
  async getCapabilities(): Promise<RouteCapabilities[]> {
    return this.registry.capabilities();
  }

  // --- commands ------------------------------------------------------------

  /**
   * Handle one UI command. Route/engine failures are reported through events
   * and kept local to their route — this method resolves once the command is
   * applied (or its failure recorded); it does not reject on engine errors.
   */
  async handleCommand(cmd: PlaybackCommand): Promise<void> {
    const p = this.chain.then(() => this.dispatch(cmd));
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  private async dispatch(cmd: PlaybackCommand): Promise<void> {
    switch (cmd.kind) {
      case "setQueue": {
        const items = cmd.items.map((it) => this.stampQueueId(it));
        this.queue = QueueOps.replaceQueue(items, cmd.startIndex ?? 0);
        this.emitQueue();
        this.persistSoon();
        const autoplay = cmd.autoplay ?? cmd.startIndex !== undefined;
        if (autoplay && this.queue.currentIndex >= 0) {
          await this.startItem(this.queue.currentIndex, {});
        } else {
          await this.teardownActive();
          this.status = "stopped";
          this.positionMs = 0;
          this.emitSnapshot();
        }
        return;
      }
      case "insertNext": {
        this.queue = QueueOps.insertNext(
          this.queue,
          cmd.items.map((it) => this.stampQueueId(it)),
        );
        this.emitQueue();
        this.refreshPrefetch();
        this.persistSoon();
        return;
      }
      case "append": {
        this.queue = QueueOps.append(
          this.queue,
          cmd.items.map((it) => this.stampQueueId(it)),
        );
        this.emitQueue();
        this.refreshPrefetch();
        this.persistSoon();
        return;
      }
      case "remove": {
        const removedCurrent =
          QueueOps.currentItem(this.queue) !== null &&
          cmd.queueIds.includes(QueueOps.currentItem(this.queue)?.queueId ?? "");
        this.queue = QueueOps.removeByQueueIds(this.queue, cmd.queueIds);
        this.emitQueue();
        this.refreshPrefetch();
        this.persistSoon();
        if (removedCurrent) {
          await this.teardownActive();
          this.status = "stopped";
          this.lease = null;
          this.positionMs = 0;
          this.emitSnapshot();
        }
        return;
      }
      case "move": {
        this.queue = QueueOps.move(this.queue, cmd.fromIndex, cmd.toIndex);
        this.emitQueue();
        this.refreshPrefetch();
        this.persistSoon();
        return;
      }
      case "play": {
        if (cmd.queueId !== undefined) {
          const idx = this.queue.items.findIndex((it) => it.queueId === cmd.queueId);
          if (idx === -1) {
            this.emitError(this.activeRouteValue ?? "local", cmd.queueId, "play: queueId not in queue", false);
            return;
          }
          await this.startItem(idx, {});
          return;
        }
        if (this.lease !== null && this.activeAdapter !== null && this.status === "paused") {
          await this.resumeAdapter();
          return;
        }
        if (this.queue.currentIndex >= 0) {
          await this.startItem(this.queue.currentIndex, { positionMs: this.positionMs });
        }
        return;
      }
      case "pause": {
        await this.pauseAdapter();
        return;
      }
      case "resume": {
        if (this.lease !== null && this.activeAdapter !== null) {
          await this.resumeAdapter();
        } else if (this.queue.currentIndex >= 0) {
          // Restored session or engine restart: load at the remembered position.
          await this.startItem(this.queue.currentIndex, { positionMs: this.positionMs });
        }
        return;
      }
      case "stop": {
        await this.teardownActive();
        this.status = "stopped";
        this.lease = null;
        this.positionMs = 0;
        this.emitSnapshot();
        this.persistSoon();
        return;
      }
      case "next": {
        const idx = QueueOps.nextIndexManual(this.queue);
        if (idx === null) {
          await this.teardownActive();
          this.status = "stopped";
          this.lease = null;
          this.emitSnapshot();
          return;
        }
        await this.startItem(idx, {});
        return;
      }
      case "previous": {
        // Restart the current track when deep into it; otherwise step back.
        if (this.positionMs > 3_000 && this.lease !== null && this.activeAdapter !== null) {
          const lease = this.lease;
          const adapter = this.activeAdapter;
          this.positionMs = 0;
          await this.guarded(() => adapter.seek(lease, 0), "seek");
          this.emitSnapshot();
          return;
        }
        const idx = QueueOps.previousIndexManual(this.queue);
        if (idx === null) return;
        await this.startItem(idx, {});
        return;
      }
      case "seek": {
        const positionMs = Math.max(0, cmd.positionMs);
        this.positionMs = positionMs;
        this.positionAtMs = this.now();
        const lease = this.lease;
        const adapter = this.activeAdapter;
        if (lease !== null && adapter !== null) {
          await this.guarded(() => adapter.seek(lease, positionMs), "seek");
        }
        this.emitSnapshot();
        this.persistSoon();
        return;
      }
      case "setVolume": {
        // Engine accepts up to 1.5 (preamp headroom); the UI slider still
        // presents 0..1.
        this.volume = Math.min(Math.max(cmd.volume, 0), 1.5);
        if (this.activeRouteValue !== null) {
          this.volumeByRoute.set(this.activeRouteValue, this.volume);
        }
        await this.applyEffectiveVolume();
        this.emitSnapshot();
        this.persistSoon();
        return;
      }
      case "setMuted": {
        this.muted = cmd.muted;
        await this.applyEffectiveVolume();
        this.emitSnapshot();
        this.persistSoon();
        return;
      }
      case "setRepeat": {
        this.queue = { ...this.queue, repeat: cmd.repeat };
        this.emitQueue();
        this.refreshPrefetch();
        this.persistSoon();
        return;
      }
      case "setShuffle": {
        this.queue = QueueOps.setShuffle(this.queue, cmd.shuffle, this.rand);
        this.emitQueue();
        this.refreshPrefetch();
        this.persistSoon();
        return;
      }
      case "switchRoute": {
        const idx = this.queue.items.findIndex((it) => it.queueId === cmd.queueId);
        if (idx === -1) {
          this.emitError(cmd.route, cmd.queueId, "switchRoute: queueId not in queue", false);
          return;
        }
        await this.startItem(idx, { positionMs: this.positionMs, routeOverride: cmd.route });
        return;
      }
      case "setFidelityMode": {
        this.fidelityMode = cmd.enabled;
        const adapter = this.activeAdapter;
        if (adapter !== null && isFidelityCapable(adapter)) {
          await this.guarded(() => adapter.setFidelityMode(cmd.enabled), "setFidelityMode");
        }
        this.emitSnapshot();
        this.persistSoon();
        return;
      }
    }
  }

  /**
   * The engine behind `route` restarted underneath us. Restore queue intent
   * WITHOUT autoplay: the item is re-loaded paused at its last position and
   * playback only resumes on an explicit user command.
   */
  async notifyEngineRestarted(route: RouteId): Promise<void> {
    const item = QueueOps.currentItem(this.queue);
    if (item === null || this.activeRouteValue !== route) return;
    this.generation += 1;
    const adapter = this.registry.get(route);
    this.lease = null;
    this.activeAdapter = null;
    if (adapter !== undefined && isRestartRestorable(adapter)) {
      try {
        await adapter.restoreAfterEngineRestart(item, this.positionMs);
      } catch (cause) {
        this.emitError(route, item.queueId, `restore after engine restart failed: ${msg(cause)}`, true);
      }
    }
    this.status = "paused";
    this.emitSnapshot();
    this.persistSoon();
  }

  /** Persist immediately (app quit) and stop timers. */
  dispose(): void {
    this.disposed = true;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persistNow();
  }

  // --- handoff -------------------------------------------------------------

  /**
   * The source handoff sequence:
   *   1. issue a fresh lease (new generation — old events go stale)
   *   2. prepare the incoming adapter
   *   3. confirmed mute/teardown of the outgoing adapter
   *   4. start the incoming item
   * A failure at any step is kept local to the route: the queue is preserved,
   * an error event carries the route + queueId, and the UI can issue a
   * deliberate `switchRoute` fallback.
   */
  /** Serialize an engine/event-driven start onto the same chain as commands. */
  private enqueueStart(index: number, opts: { positionMs?: number; routeOverride?: RouteId } = {}): void {
    this.chain = this.chain.then(() => this.startItem(index, opts)).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Bound a call so a wedged adapter can't stall the coordinator forever. */
  private async withTimeout<T>(p: Promise<T>, ms: number, op: string): Promise<T> {
    let t: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_r, rej) => {
          t = setTimeout(() => rej(new Error(`${op} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (t !== null) clearTimeout(t);
    }
  }

  private async startItem(
    index: number,
    opts: { positionMs?: number; routeOverride?: RouteId },
  ): Promise<void> {
    const item = this.queue.items[index];
    if (item === undefined) return;
    this.clearPromotionWait();
    this.pendingPrefetch = null;
    const route = opts.routeOverride ?? item.track.route;
    const adapter = this.registry.get(route);
    this.generation += 1;
    const lease: PlaybackLease = {
      generationId: this.generation,
      route,
      queueId: item.queueId,
      issuedAtMs: this.now(),
    };
    if (adapter === undefined) {
      this.lease = lease;
      this.status = "error";
      this.lastError = { route, queueId: item.queueId, message: `no adapter registered for route "${route}"`, retriable: false };
      this.emitError(route, item.queueId, this.lastError.message, false);
      this.emitSnapshot();
      return;
    }

    const outgoing = this.activeAdapter !== null && this.activeAdapter !== adapter ? this.activeAdapter : null;
    const outgoingLease = this.lease;
    const previousIndex = this.queue.currentIndex;
    const previousDuration = this.durationMs;
    const previousPosition = this.positionMs;
    // Intent shows in the queue before the lease commits: the incoming route
    // must prove it can start (prepare) before it owns the generation. Until
    // then the outgoing adapter keeps its lease — its events stay valid and
    // it remains controllable if the handoff fails.
    if (previousIndex !== index) {
      this.queue = { ...this.queue, currentIndex: index };
      this.emitQueue();
    }
    this.status = "loading";
    this.durationMs = item.track.durationMs;
    if (opts.positionMs !== undefined) this.positionMs = opts.positionMs;
    this.emitSnapshot();

    try {
      await this.withTimeout(adapter.prepare(), 15_000, "adapter.prepare");
    } catch (cause) {
      // Roll back: outgoing keeps its lease, adapter and queue position.
      this.queue = { ...this.queue, currentIndex: previousIndex };
      this.durationMs = previousDuration;
      this.positionMs = previousPosition;
      this.emitQueue();
      this.failStart(route, item.queueId, `prepare failed: ${msg(cause)}`, true);
      return;
    }

    // Confirmed teardown: wait for the outgoing engine to go silent before
    // starting the next source. A teardown failure is reported but cannot be
    // allowed to wedge the handoff — the incoming source still starts.
    if (outgoing !== null && outgoingLease !== null) {
      try {
        await this.withTimeout(outgoing.stop(outgoingLease), 8_000, "outgoing.stop");
        this.activeAdapter = null;
      } catch (cause) {
        this.emitError(
          outgoing.route,
          outgoingLease.queueId,
          `outgoing route failed to go silent: ${msg(cause)}`,
          true,
        );
      }
    }

    // Tail of the promotion race: the engine may have started this exact
    // track itself after our 600ms fallback already enqueued. Re-pointing is
    // enough — a play call here would restart a track already sounding.
    const alreadyPromoted =
      this.promotedQueueId === item.queueId &&
      adapter === this.activeAdapter;
    // The incoming route is ready and the outgoing one silent — commit the
    // lease only now, so a failed prepare above left the old route intact.
    this.handledEnded.clear();
    this.lease = lease;
    if (alreadyPromoted) {
      this.status = "playing";
      this.lastError = undefined;
      this.emitSnapshot();
      this.persistSoon();
      this.refreshPrefetch();
      return;
    }
    this.promotedQueueId = null;
    const playOpts: { positionMs?: number } = {};
    if (opts.positionMs !== undefined) playOpts.positionMs = opts.positionMs;
    try {
      await this.withTimeout(adapter.play(item, lease, playOpts), 20_000, "adapter.play");
    } catch (cause) {
      this.failStart(route, item.queueId, `play failed: ${msg(cause)}`, true);
      return;
    }

    this.activeAdapter = adapter;
    this.activeRouteValue = route;
    // Per-route conservative volume memory: the incoming engine gets back
    // whatever level the user last set on this route.
    this.volume = this.volumeByRoute.get(route) ?? this.volume;
    this.status = "playing";
    this.lastError = undefined;
    this.setQueueOwner(this.ownerFor(route));
    await this.applyEffectiveVolume();
    this.emitSnapshot();
    this.persistSoon();
    void this.prefetchSuccessor(adapter);
  }

  /** Stop whatever the active adapter has sounding under the current lease. */
  private async teardownActive(): Promise<void> {
    const adapter = this.activeAdapter;
    const lease = this.lease;
    this.activeAdapter = null;
    if (adapter !== null && lease !== null) {
      try {
        await adapter.stop(lease);
      } catch (cause) {
        this.emitError(lease.route, lease.queueId, `stop failed: ${msg(cause)}`, true);
      }
    }
    this.persistSoon();
  }

  /** Record a start failure: error stays local to the route, queue preserved. */
  private failStart(route: RouteId, queueId: string, message: string, retriable: boolean): void {
    this.status = "error";
    this.lastError = { route, queueId, message, retriable };
    this.emitError(route, queueId, message, retriable);
    this.emitSnapshot();
    this.persistSoon();
  }

  /** Queue changed — an installed engine prefetch may now be stale. Re-issue
   * for the actual successor (the engine overwrites its `next` slot). */
  private refreshPrefetch(): void {
    if (this.status !== "playing" || this.activeAdapter?.prefetch === undefined) return;
    this.pendingPrefetch = null;
    void this.prefetchSuccessor(this.activeAdapter);
  }

  /** Best-effort gapless: prefetch the next same-route item on the active adapter. */
  private async prefetchSuccessor(adapter: RouteAdapter): Promise<void> {
    if (adapter.prefetch === undefined) return;
    const nextIdx = QueueOps.nextIndexAfterEnd(this.queue);
    if (nextIdx === null || nextIdx === this.queue.currentIndex) return;
    const next = this.queue.items[nextIdx];
    if (next === undefined || next.track.route !== adapter.route) return;
    try {
      await adapter.prefetch(next);
      this.pendingPrefetch = next.queueId;
    } catch {
      // Prefetch is an optimization; a failure only costs the seamlessness.
    }
  }

  // --- adapter passthrough ---------------------------------------------------

  private async pauseAdapter(): Promise<void> {
    const adapter = this.activeAdapter;
    const lease = this.lease;
    if (adapter === null || lease === null) return;
    if (await this.guarded(() => adapter.pause(lease), "pause")) {
      this.status = "paused";
    }
    this.emitSnapshot();
    this.persistSoon();
  }

  private async resumeAdapter(): Promise<void> {
    const adapter = this.activeAdapter;
    const lease = this.lease;
    if (adapter === null || lease === null) return;
    if (await this.guarded(() => adapter.resume(lease), "resume")) {
      this.status = "playing";
    }
    this.emitSnapshot();
    this.persistSoon();
  }

  /**
   * Run an adapter call; failures are reported route-locally, never thrown.
   * Returns false when the call failed so callers skip optimistic state.
   */
  private async guarded(call: () => Promise<void>, op: string): Promise<boolean> {
    const lease = this.lease;
    try {
      await call();
      return true;
    } catch (cause) {
      const route = lease?.route ?? this.activeRouteValue ?? "local";
      this.emitError(route, lease?.queueId, `${op} failed: ${msg(cause)}`, true);
      return false;
    }
  }

  private async applyEffectiveVolume(): Promise<void> {
    const adapter = this.activeAdapter;
    if (adapter === null) return;
    const effective = this.muted ? 0 : this.volume;
    try {
      await adapter.setVolume(effective);
    } catch (cause) {
      this.emitError(adapter.route, this.lease?.queueId, `setVolume failed: ${msg(cause)}`, true);
    }
  }

  // --- adapter / graph events -------------------------------------------------

  private onAdapterEvent(route: RouteId, e: AdapterEvent): void {
    if (this.disposed) return;
    if (e.kind === "error") {
      // Adapter errors carry no generationId; they stay local to their route.
      const isActive = route === this.activeRoute;
      if (isActive && this.lease !== null) {
        this.lastError = { route, queueId: this.lease.queueId, message: e.message, retriable: e.retriable };
      }
      this.emitError(route, this.lease?.queueId, e.message, e.retriable);
      if (isActive) this.emitSnapshot();
      return;
    }
    if (e.kind === "capabilitiesChanged") {
      void this.registry
        .get(route)
        ?.capabilities()
        .then((capabilities) => this.emit({ kind: "capabilities", route, capabilities }))
        .catch(() => undefined);
      return;
    }
    // Generation-gated events below.
    if (this.lease === null || e.generationId !== this.lease.generationId) return;
    switch (e.kind) {
      case "started": {
        // Engine self-promotion: a started whose queueId is not the item we
        // told the engine to play means the engine advanced into its own
        // prefetch (gapless or renegotiated reopen). Never re-load it.
        const selfPromoted =
          e.promoted === true ||
          (e.queueId !== undefined && e.queueId !== this.lease?.queueId);
        if (selfPromoted) {
          this.promoteTrack(e.queueId, e.durationMs);
          return;
        }
        this.status = "playing";
        if (e.durationMs !== undefined && e.durationMs > 0) this.durationMs = e.durationMs;
        this.emitSnapshot();
        return;
      }
      case "position": {
        this.positionMs = e.positionMs;
        this.positionAtMs = e.atMs;
        if (e.positionMs <= this.durationMs || this.durationMs === 0) {
          this.emit({ kind: "position", positionMs: e.positionMs, atMs: e.atMs, generationId: e.generationId });
        }
        this.persistSoon();
        return;
      }
      case "state": {
        if (e.status !== this.status) {
          this.status = e.status;
          this.emitSnapshot();
          this.persistSoon();
        }
        return;
      }
      case "ended": {
        // Dedupe: a track's end can arrive via several paths (engine event
        // fan-in across adapters sharing the graph). Ended events carry the
        // ended track's queueId — the same track ending twice under the same
        // generation is always a duplicate.
        const endedKey = `${e.generationId}:${e.queueId ?? this.lease.queueId}`;
        if (this.handledEnded.has(endedKey)) return;
        this.handledEnded.add(endedKey);
        const queueId = e.queueId ?? this.lease.queueId;
        this.emit({ kind: "trackEnded", queueId, generationId: e.generationId });
        const idx = QueueOps.nextIndexAfterEnd(this.queue);
        if (idx === null) {
          this.status = "stopped";
          this.lease = null;
          this.activeAdapter = null;
          this.positionMs = 0;
          this.emitSnapshot();
          this.persistSoon();
          return;
        }
        // When we prefetched a successor, the engine may promote it itself:
        // seamlessly (gapless:true) or after a format renegotiation. Give the
        // self-promoted `started` a short window before driving the advance
        // ourselves — a redundant load here would restart a track already
        // playing, which is exactly the seam the engine exists to remove.
        if (this.pendingPrefetch !== null) {
          const fallbackIdx = idx;
          this.promotionTimer = setTimeout(() => {
            this.promotionTimer = null;
            if (this.pendingPrefetch !== null) this.pendingPrefetch = null;
            this.enqueueStart(fallbackIdx);
          }, 600);
          return;
        }
        this.enqueueStart(idx);
        return;
      }
      case "queueChanged": {
        // Explicit reconcile of provider-owned queue truth.
        const items = parseProviderQueue(e.providerQueue, (it) => this.stampQueueId(it));
        this.queue = {
          owner: "provider",
          items,
          currentIndex: items.length === 0 ? -1 : Math.min(this.queue.currentIndex, items.length - 1),
          shuffle: false,
          repeat: this.queue.repeat,
        };
        this.emitQueue();
        this.persistSoon();
        return;
      }
    }
  }

  private clearPromotionWait(): void {
    if (this.promotionTimer !== null) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
  }

  /**
   * The engine promoted a successor itself. Advance queue intent to match —
   * same generation (the engine session never broke), new queueId, fresh
   * prefetch for the item after it. No adapter.play call: the audio is
   * already running.
   */
  private promoteTrack(queueId: string | undefined, durationMs?: number): void {
    this.clearPromotionWait();
    let idx = queueId !== undefined
      ? this.queue.items.findIndex((it) => it.queueId === queueId)
      : -1;
    if (idx < 0 && this.pendingPrefetch !== null) {
      idx = this.queue.items.findIndex((it) => it.queueId === this.pendingPrefetch);
    }
    if (queueId !== undefined && idx < 0) {
      // The engine promoted a successor we no longer know (queue was edited
      // after the prefetch installed). Honest state: keep the lease on the
      // playing track's queueId, warn, and let the next end recover intent.
      this.pendingPrefetch = null;
      this.emitError(
        this.lease?.route ?? "local",
        this.lease?.queueId ?? queueId,
        "engine promoted a track that left the queue — playback continues, queue intent resumes at next boundary",
        true,
      );
      if (this.lease !== null) this.lease = { ...this.lease, queueId };
      return;
    }
    if (idx < 0) idx = QueueOps.nextIndexAfterEnd(this.queue) ?? -1;
    this.pendingPrefetch = null;
    const item = idx >= 0 ? this.queue.items[idx] : undefined;
    if (this.lease === null || item === undefined) return;
    this.promotedQueueId = item.queueId;
    this.lease = { ...this.lease, queueId: item.queueId, issuedAtMs: this.now() };
    if (this.queue.currentIndex !== idx) {
      this.queue = { ...this.queue, currentIndex: idx };
      this.emitQueue();
    }
    this.status = "playing";
    this.positionMs = 0;
    this.positionAtMs = this.now();
    this.durationMs =
      durationMs !== undefined && durationMs > 0 ? durationMs : item.track.durationMs;
    this.emitSnapshot();
    this.persistSoon();
    const adapter = this.activeAdapter;
    if (adapter !== null) void this.prefetchSuccessor(adapter);
  }

  private onGraphEvent(e: AudioRpcEvent): void {
    if (this.disposed || this.lease === null) return;
    const lease = this.lease;
    switch (e.method) {
      case "event.fft": {
        if (e.params.generationId !== lease.generationId) return;
        this.emit({ kind: "fft", bands: e.params.bands, peak: e.params.peak, atMs: e.params.atMs, generationId: e.params.generationId });
        return;
      }
      case "event.output": {
        this.output = {
          deviceName: e.params.deviceName,
          sampleRateHz: e.params.sampleRateHz,
          channels: e.params.channels,
          bitDepth: e.params.bitDepth,
          exclusive: e.params.exclusive,
          fidelityBypass: e.params.fidelityBypass,
        };
        this.emit({ kind: "output", output: this.output });
        this.emitSnapshot();
        return;
      }
      default:
        return;
    }
  }

  // --- persistence ------------------------------------------------------------

  /** Restore queue + position from settings without touching any engine. */
  private restoreFromSettings(): void {
    const parsed = parsePersistedPlayback(this.store.loadSection("playback"));
    if (parsed === null) return;
    this.queue = { ...parsed.queue, owner: "coordinator" };
    this.positionMs = parsed.positionMs;
    this.positionAtMs = this.now();
    this.volume = parsed.volume;
    this.muted = parsed.muted;
    this.fidelityMode = parsed.fidelityMode;
    for (const [route, v] of Object.entries(parsed.volumeByRoute)) {
      if (v !== undefined) this.volumeByRoute.set(route as RouteId, v);
    }
    // Restored intent is paused: a resume/play command loads at positionMs.
    this.status = QueueOps.currentItem(this.queue) === null ? "stopped" : "paused";
    this.durationMs = QueueOps.currentItem(this.queue)?.track.durationMs ?? 0;
    for (const it of this.queue.items) {
      const seq = parseInt(it.queueId.replace(/^q/, ""), 10);
      if (Number.isFinite(seq) && seq > this.queueIdSeq) this.queueIdSeq = seq;
    }
  }

  private persistSoon(): void {
    if (this.disposed) return;
    if (this.persistDebounceMs <= 0) {
      this.persistNow();
      return;
    }
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    const state: PersistedPlayback = {
      version: 1,
      queue: this.queue,
      positionMs: this.positionMs,
      volume: this.volume,
      muted: this.muted,
      fidelityMode: this.fidelityMode,
      volumeByRoute: Object.fromEntries(this.volumeByRoute) as Partial<Record<RouteId, number>>,
    };
    try {
      this.store.saveSection("playback", state);
    } catch {
      // Persistence is best-effort; losing resume state is recoverable.
    }
  }

  // --- helpers -----------------------------------------------------------------

  private stampQueueId(item: QueueItem): QueueItem {
    // The coordinator owns queueIds; incoming ids are hints only. Re-stamping
    // guarantees uniqueness even for duplicate tracks or colliding UI ids.
    this.queueIdSeq += 1;
    return { ...item, queueId: `q${this.queueIdSeq}` };
  }

  private ownerFor(route: RouteId): QueueState["owner"] {
    // Routes whose playback engine we drive keep coordinator-owned queue truth;
    // provider engines can be edited externally and own their queue.
    return route === "local" || route === "spotify-librespot" ? "coordinator" : "provider";
  }

  private setQueueOwner(owner: QueueState["owner"]): void {
    if (this.queue.owner !== owner) {
      this.queue = { ...this.queue, owner };
      this.emitQueue();
    }
  }

  private emit(e: CoordinatorEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  private emitSnapshot(): void {
    this.emit({ kind: "snapshot", snapshot: this.getSnapshot() });
  }

  private emitQueue(): void {
    this.emit({ kind: "queue", queue: this.queue });
  }

  private emitError(route: RouteId, queueId: string | undefined, message: string, retriable: boolean): void {
    if (queueId === undefined) {
      this.emit({ kind: "error", route, message, retriable });
    } else {
      this.emit({ kind: "error", route, queueId, message, retriable });
    }
  }
}

function msg(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Best-effort parse of a provider-reported queue into QueueItems. Items that
 * do not look like QueueItems are dropped; queueIds are re-stamped by the
 * caller so provider ids cannot collide with coordinator ids.
 */
function parseProviderQueue(u: unknown, stamp: (it: QueueItem) => QueueItem): QueueItem[] {
  if (!Array.isArray(u)) return [];
  const items: QueueItem[] = [];
  for (const raw of u) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const track = item.track;
    if (typeof track !== "object" || track === null) continue;
    // SAFETY: provider queues are best-effort; we checked the envelope
    // (object with a track object) and the coordinator re-stamps queueIds.
    items.push(stamp(item as unknown as QueueItem));
  }
  return items;
}
