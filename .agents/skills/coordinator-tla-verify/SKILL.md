---
name: coordinator-tla-verify
description: Re-run and extend the TLA+ formal verification of the desktop playback coordinator (leases, handoff/promotion, command chain, restore). Use when changing coordinator.ts, persisted-state.ts, or adapter event handling — or when a spec check fails and you need to triage it.
---

# Coordinator formal verification

The coordinator's highest-risk promises are model-checked with TLA+ via
`tla-ts` (a TLC-compatible Node checker — no Java). Specs live in
`apps/desktop/spec/tla/`; the runner is `apps/desktop/scripts/check-specs.mjs`.

## Run

```sh
# pass configs only (must all be clean)
node apps/desktop/scripts/check-specs.mjs

# mutations only (each mutant must be REJECTED by its declared property)
node apps/desktop/scripts/check-specs.mjs --mutants
```

Also run `npx vitest run test/coordinator-verify.test.ts` (replay of every
checker-found bug) and `npx vitest run test/coordinator-model.test.ts`
(fast-check random trace replay of the same invariants).

tla-ts always exits 0 — the runner parses stdout for `^Error` /
`No error`. Do not trust exit codes.

## What is verified, in plain words

`CoordinatorChain.tla` — the `chain: Promise<void>` serialization.
- `NoDropped`: a rejected link never eats the command behind it.
- `TimeoutFrees`: a timed-out link always lets later work proceed.
- `NoStuck`: nothing is permanently blocked.
- Liveness: every enqueued link either runs or is dropped by bound.

`CoordinatorLease.tla` — generation-gated adapter events.
- `EndedProcessedOnce`: one `ended` per (generation, track) — dedupe works.
- `StalePositionNoEffect`: events from a dead generation cannot change
  `positionMs`/`status` — the gate drops them.

`CoordinatorHandoff.tla` — prepare → outgoing-stop → commit →
resile (awaited re-stop, cross-route) → play.
- `SingleAudible`: at most one route's engine sounds, excluding routes
  whose stop failure was reported (`stoppedBad` is per-route) and the
  `resile` phase itself (the incoming engine may report `started` while
  the awaited re-stop is still resolving — dual-sounding that survives
  the phase still violates).
- `StopBeforePlay`: incoming play is only attempted after outgoing
  teardown was attempted.
- `PrepareFailRollback`: a failed prepare leaves queue intent on the item
  the surviving lease names — not a remembered previous index (a
  self-promotion during prepare can move the lease).
- `PendingPrefetchSound`: `pendingPrefetch` only ever names the live
  lease's successor on the active adapter.
- `NoStaleAdvance`: an `ended`-advance link never issues a real play
  over a lease minted after it was queued.
- `NoMovedAdvance`: an advance never runs a real start while the lease
  names a different item than the track that ended — generation alone
  cannot see a same-generation promotion or a prepare-fail rollback.
- `AdvanceTargetSound`: an advance that reaches a real play targets the
  successor of the ENDED item, recomputed at run time — not a provisional
  index baked at event time.
- `PlayingLeaseSound`: when settled and playing, the lease names the
  current queue item or a known-foreign promotion (`lease.qid ∉ Items`,
  the documented warn path — NOT the old sticky `foreignPromo` flag,
  which would exempt the property forever after one foreign event).
- `PlayingMeansSounding`: settled and playing ⇒ a live lease whose
  engine is sounding, or an advance is owed/armed/queued.
- `StartCompletes`, `AdvanceTerminates` (liveness): handoffs settle and
  every ended-obligated advance resolves — truncated runs at the step
  bound do not count.

`CoordinatorRestore.tla` — persisted-state validation + startup/restart.
- `RestoredSound`: a restored queue has integer index in bounds
  (or -1 when empty) and full track shape.
- `NoAutoplay`: restoring never starts playback by itself.
- `ExplicitStart`: after restore, playback requires a user command.
- Liveness: restart always settles back to a stable status.

## Sync point

Specs were written against `coordinator.ts` / `persisted-state.ts` at
merge-base `042d5b4` (main, Nov 2025), plus the fixes on this branch.
When the coordinator changes, re-check every action against the model —
see "extending" below.

## Bounds and tool limits

- Bounded exploration: `MaxSteps=18`, `MaxGen=5`, `MaxStarts=2`, 3 items,
  2 routes (`local`, `youtube-music`). Bugs beyond the bound are not
  covered. Found violations were all ≤ depth ~15.
- Liveness under a step bound is reported "complete or truncated" — a
  counterexample that only ends at `stepCount = MaxSteps` is a bound
  artifact, not a real bug.
- Environment (adapter events) is nondeterministic but contracted: events
  arrive on the lease's adapter with plausible generations; a physically
  impossible env (e.g. an engine reporting `started` while already
  sounding, or events on an adapter that never held the lease) is out of
  scope. `EnginePromoted` only fires inside promotion windows or
  mid-handoff and only toward the successor / installed prefetch / a
  foreign id.
- `sounding` models engine truth as seen through events; `stoppedBad ⊆
  Routes` tolerates a reported teardown failure per-route — a second
  unreported double-sounding still violates.
- The queue is `succ`/`removed` (VARIABLES, not constants): `QueueRemove`
  unlinks a non-live item, which is how the null-successor teardown in
  `BeginStart` becomes reachable — the ended link's `succ[endedQid]`
  recomputes to 0 after its target is removed behind it.
- `BeginStart` order matches code: staleness check → removed-item no-op
  → null-successor teardown (status, lease, adapter stop) → real start.
- ended-advance staleness is a (generation, queueId) pair check: the
  link must skip BEFORE `startItem` clears promotion state — the code
  checks inside the chain task, the model has a matching "skip keeps
  armed/prefetch" branch.
- The promotion window is `armedGen`/`armedQid` (the ended lease's
  identity), not a boolean — the timer re-validates before enqueueing.
- tla-ts quirks hit so far: errors are stdout-only (exit 0); `x' = a \/ b`
  parses as `(x' = a) \/ b` — always parenthesize primed disjunctions;
  `INIT`/`NEXT` config silently ignores fairness — use
  `SPECIFICATION Spec`; 12_000 literals and record/string comparisons are
  rejected; module name must equal file name; `enabled` checks do not
  short-circuit function application (guard `sounding[lease.route]` with
  `IF HasLease THEN ...`).

## Triage: model bug vs drift vs product bug

1. Read the counterexample with the `statechart` skill — TLA+ traces are
  state sequences; translate each transition to coordinator.ts lines.
2. Replay it against the real code: `test/coordinator-verify.test.ts` is
  the catalog — each checker finding has a named test. If the real code
  cannot produce the interleaving (e.g. an env action the code's
  serialization forbids), the MODEL is wrong — tighten the env action and
  re-run. If the code produces it and violates the property, it's a
  product bug — write the failing test first, then fix in plain
  TypeScript. Never weaken a property to make a bug pass.
3. A spec that passes but doesn't cover a code path is drift — the sync
  point above is stale. Update the model, re-run mutants to prove the
  new invariant can fail.

## Mutation checks

`check-specs.mjs --mutants` runs ONLY mutations (pass configs run in the
default mode — CI/verify.sh call both):
- `*.mutant-*.cfg` files: constants flip a guard to the buggy shape.
  Each declares `\* EXPECTS <Name>|<Name>` — the run must be rejected
  by one of the named properties.
- `TEXT_MUTANTS` in `check-specs.mjs`: textual rewrites of the spec back
  to the buggy code shape, each with `expects: [...]` of acceptable
  blamed properties.

A mutant rejected by a parse error, a crash, a timeout, or the WRONG
property counts as a failure — a green mutant run means every guard
provably kills its own property, nothing else.

To prove a NEW property can fail: add a constant or a TEXT_MUTANTS entry
that removes its guard, run `--mutants`, and confirm the checker rejects
it with your invariant's name.

## Extending when the coordinator changes

- Model indivisible code actions as indivisible TLA actions: one `await`
  boundary per action. The coordinator's commit point is
  `this.lease = lease` (`CommitLease`), followed by the awaited re-stop
  of the outgoing engine (`ResilenceResolve`) before `PlayResolve`.
- Keep env actions faithful: they should only be able to do what the
  adapter contract allows, but every allowed interleaving must be modeled
  (that is where the bugs live).
- After editing a spec, run the pass config, then `--mutants`, then the
  fast-check harness — it must still hold the invariants on real code.

## Rust audio service (Kani)

Out of scope for now. Worth revisiting only if the service gains logic
with invariants that matter (state machines, lock-free buffers); today it
is mostly IO plumbing where a model adds little. Note this if asked.
