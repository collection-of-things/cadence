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
# fast: pass configs only (must all be clean)
node apps/desktop/scripts/check-specs.mjs

# full: pass configs + every mutation (each mutant must be REJECTED)
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

`CoordinatorHandoff.tla` — prepare → outgoing-stop → commit → play.
- `SingleAudible`: at most one route's engine sounds (unless a stop
  failure was reported).
- `StopBeforePlay`: incoming play is only attempted after outgoing
  teardown was attempted.
- `PrepareFailRollback`: a failed prepare leaves queue intent on the item
  the surviving lease names.
- `PendingPrefetchSound`: `pendingPrefetch` only ever names the live
  lease's successor on the active adapter.
- `NoStaleAdvance`: an `ended`-advance link queued under generation G can
  only run while G is still the lease's generation.
- `AdoptedWhenEligible`: an adopt-promotion link that still names the
  promoted item adopts it instead of issuing a real play.
- `PlayingLeaseSound`: when settled and playing, the lease names the
  current queue item (foreign promotions excepted — see warn path).
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
- `sounding` models engine truth as seen through events; `stopFailed`
  tolerates a reported teardown failure.
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

`check-specs.mjs --mutants` runs two kinds:
- `*.mutant-*.cfg` files: constants flip a guard to the buggy shape.
- `TEXT_MUTANTS` in `check-specs.mjs`: textual rewrites of the spec back
  to the buggy code shape (each names the invariant that must fire).

To prove a NEW property can fail: add a constant or a TEXT_MUTANTS entry
that removes its guard, run `--mutants`, and confirm the checker rejects
it with your invariant's name.

## Extending when the coordinator changes

- Model indivisible code actions as indivisible TLA actions: one `await`
  boundary per action. The coordinator's commit point is
  `this.lease = lease` — the spec has a matching `CommitLease` action.
- Keep env actions faithful: they should only be able to do what the
  adapter contract allows, but every allowed interleaving must be modeled
  (that is where the bugs live).
- After editing a spec, run the pass config, then `--mutants`, then the
  fast-check harness — it must still hold the invariants on real code.

## Rust audio service (Kani)

Out of scope for now. Worth revisiting only if the service gains logic
with invariants that matter (state machines, lock-free buffers); today it
is mostly IO plumbing where a model adds little. Note this if asked.
