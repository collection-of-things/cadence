# Council: Effect, Alchemy, and the testing/verification question for Cadence

Date: 2026-11-06. Question from Nirvaan: how much would Cadence benefit from
Effect (effect.website) and alchemy.run — and do they deliver the end-to-end
testing and formal verification he hopes for?

Council: three seats, two rounds of parallel independent positions followed by
cross-critique. Research and advice only; no code was changed.

| Seat | Model run | Provider |
| --- | --- | --- |
| Terra | `gpt-6.1-terra` (reasoningEffort high) | codex |
| SWE-2 | `swe-2-high` | acpRegistry_devin |
| Devin Fusion | `fusion-claude-opus-5-5-medium-sidekick-swe-2-medium` | acpRegistry_devin |

## Verdicts

| Tool | Verdict | Where first / trigger |
| --- | --- | --- |
| Effect runtime (fibers, Scope, Layer, TestClock) | **Defer** | Trigger: a second concurrent writer to queue intent (provider queue mirroring) or lifecycle complexity that resists plain repair. If trialed: `audio-client.ts` only, behind its Promise API |
| Schema validation (any lib) | **Adopt now — zod 4** | `persisted-state.ts`, `ipc-validation.ts`, `json-rpc.ts` event params, `parseProviderQueue`. Valibot acceptable; Effect Schema only if Effect later earns the dep |
| Alchemy | **Skip** | Trigger: first real backend resource (the un-shipped Apple developer-token endpoint). Even then, compare against plain `wrangler` |
| fast-check | **Adopt now** | `fc.commands` + `fc.scheduler()` over `Coordinator` + `FakeAdapter`; property tests on `queue-ops.ts` and persisted-state round-trips |
| Quint (or TLA+) | **Small trial** | Model the lease/promotion/handoff protocol; replay traces via `@firfi/quint-connect` |
| Playwright-Electron | **Adopt now** | Packaged-app smoke test: isolated `userData`, local fixture, null sink, quit/relaunch → restored paused state |
| XState | **Skip** | No demonstrated need for a second state-machine runtime |

Unanimous on every row after round 2. The only residual disagreement is inside
the Effect verdict: when deferred Effect should get its trial (see below).

## The premise, checked

Nirvaan guessed Alchemy could help with e2e testing and maybe formal
verification. It cannot, on either count — all three seats verified this
against alchemy.run's own docs:

- **Alchemy is infrastructure-as-code** ("Infrastructure-as-Effects") — a
  pure-TypeScript IaC engine built on Effect for Cloudflare, AWS, GCP, K8s,
  Fly, Railway, Hetzner, Neon. Its test story is "deploy a real stack in
  `beforeAll`, assert, destroy in `afterAll`". That tests deployed cloud
  resources. It cannot launch Electron, drive a window, sign into a provider,
  or check playback invariants. It has no model checking or verification
  capability at all.
- Cadence has **zero cloud resources** today — no backend, no CI infra. The
  only foreseen one is the Apple MusicKit developer-token signing endpoint
  (open issue #6 in the v1 report): one Worker. `wrangler` plus a vitest smoke
  test covers that. Alchemy earns its keep at many resources, not one.
- **Effect is a runtime, not a checker.** TestClock/TestServices make
  Effect-written code deterministic under test; they presuppose the migration
  and don't motivate it. Cadence's tests already inject `now`, `rand`,
  `sleep`, `persistDebounceMs` and run a `FakeAdapter` rig — the determinism
  Effect sells is already bought.
- Correction found mid-council: Playwright's Electron API did **not** move to
  `@playwright/electron` — that split was reverted (PR #40733, 2026-05-09).
  The live API is `import { _electron } from 'playwright'`, still labeled
  experimental, Electron v21+.

## What the council found in the code

Fusion's audit surfaced real defects in the coordinator that the lead
confirmed. They set the stakes for every verdict below:

1. **Unbounded `setVolume` in the serialized chain.** `applyEffectiveVolume`
   calls `adapter.setVolume` with no `withTimeout`
   (`coordinator.ts:710-719`), and `startItem` awaits it at line 608. One
   stuck provider `setVolume` freezes every later command — contradicting the
   v1 report's "timeouts on every adapter call".
2. **Untracked prefetch.** `prefetchSuccessor` runs fire-and-forget outside
   the chain and sets `pendingPrefetch` only after its `await`
   (`coordinator.ts:656-668`). A handoff in between leaves a stale
   `pendingPrefetch` that can arm the 600 ms window and the `promoteTrack`
   fallback on a wrong belief.
3. **Unguarded chain links.** `notifyEngineRestarted` (line 402) and the
   `ended` path (lines 824-829) extend `this.chain` without the rejection
   guard `enqueueStart` uses. A rejection there silently drops the next user
   command.
4. **Shallow persisted-state check.** `isQueueState`
   (`persisted-state.ts:27-41`) checks only that items have a string
   `queueId` and an object `track` — no `currentIndex` bounds, no track
   shape. Corrupt settings pass and fail later.
5. **Unchecked audio events.** `parseLine` casts event `params` unchecked
   (`json-rpc.ts` ~L45-50, justified by a "trusted local peer" comment).
6. **Tests wait in real time** (`setTimeout(r, 700)` in
   `gapless-promotion.test.ts:79`; zero `vi.useFakeTimers` in the repo).
7. **No CI.** `scripts/verify.sh` runs only by hand.

Each of 1-3 is a ~15-30-line plain-TS fix (wrap the call; generation-gate the
prefetch write; unify all `this.chain` extensions behind one guarded
`extendChain`). That fact drove the Effect verdict.

## Effect

### Where it would concretely help

- **`audio-client.ts`** (652 lines) already hand-rolls Effect's ideas: four
  `_tag` error classes, bounded exponential backoff, per-request timers, a
  pending-request map, intentional-stop flags. `acquireRelease`/`Scope` make
  child-process ownership explicit; `Schedule` replaces hand-rolled backoff;
  `TestClock` makes restart timing deterministic in tests.
- **Schema at the validation seams** would collapse ~400 lines of
  hand-rolled `unknown`-narrowing (`ipc-validation.ts` 338 lines +
  `persisted-state.ts` + `parseProviderQueue`) into declarations that could
  live in `packages/protocol` and serve main, preload, and tests — and would
  have caught defect 4 by construction.
- **`coordinator.ts`**: lease-scoped fibers would tie prefetch, timers, and
  play to a lease's lifetime; `Effect.timeout` composes with interruption;
  a semaphore/mailbox replaces the hand-built chain with its three different
  link styles.

### Where it would not help

- **Provider late starts** (open issue: a timed-out `adapter.play` can't
  cancel a provider's late start). Interruption stops *waiting*; it cannot
  stop an `executeJavaScript` already dispatched into a provider page or a
  librespot subprocess. That fix is an adapter `AbortSignal`/cancel contract,
  whichever runtime is chosen.
- **The 600 ms promotion heuristic.** It is a missing engine event
  ("prefetch starting"), not a code-shape problem. No library removes it;
  the fix is a protocol addition.
- **The Rust service, the renderer, hot event fan-out.** Rust is untouched;
  Zustand is fine; `@effect/atom-react` needs React 19 and apps/ui pins
  React 18 — Effect would live in Electron main only, forever.

### Costs

- Bundle size is a non-issue in Electron main (tsup, CJS). Zero-dep core;
  real Electron precedent exists (opencode's desktop bundles Effect in main;
  community `electron-effect-starter` runs Electron 45 + Effect 4). Measure
  actual tsup output rather than trusting the 7.1 kB floor.
- The real cost is the dialect: `Effect.gen`, Layers, and the R/E type
  channels spread through whatever they touch, and the two candidate files
  carry five rounds of baked-in race fixes. A rewrite introduces *new* bug
  classes (fiber leaks, Deferred misuse, scoping errors) the existing 36
  real-timer tests won't surface.

### E2E / formal verification

Does not hold. Typed errors are not checked invariants; TestClock does not
control code that isn't written in Effect.

### Verdict: defer

All three seats converged: plain-TS repair of the three defects plus
fast-check generated interleavings gives the same assurance as a rewrite, at
a fraction of the cost, without putting a new paradigm into the file with
the most bug fixes.

- **Trigger (agreed):** provider queue mirroring lands and `queueChanged`
  becomes a second concurrent writer to queue intent — the moment
  `this.chain` plus promotion timers gain a second mutation source, a
  mailbox/state-fiber rewrite pays for itself. Revisit also if lifecycle
  defects keep recurring after repair.
- **Designated trial site when triggered:** `audio-client.ts` behind its
  existing Promise interface. Gate: existing `audio-client.test.ts` passes
  unchanged plus a `TestClock`-driven restart-backoff test the current impl
  can't express.
- Residual disagreement: SWE-2 would run the audio-client trial now as a
  bounded experiment; Terra and Fusion would wait for a demonstrated need
  (a lifecycle property test that fails and resists plain repair). Reported
  position: defer the trial itself; the trigger above decides.

## Alchemy

Nothing in Cadence deploys cloud infrastructure, so Alchemy has no job. Its
test story (deploy real infra, assert, destroy) is genuinely good — for infra.
It cannot test the app, and "type checking proves your infra is correct" means
bindings and IAM line up, not that anything behaves.

**Verdict: skip.** Trigger: the first real backend resource — most likely the
Apple developer-token endpoint, which also unblocks credentialed Apple
playback tests. Even then, choose it over `wrangler` only if Effect already
won in main.

## What actually serves the e2e and verification goals

**fast-check — adopt now.** `fc.commands` + `fc.scheduler()` over
`Coordinator` + `FakeAdapter`, permuting the order adapter promises resolve —
this targets defects 1-3 and their class directly. Invariants the seats
pooled: stale generations/routes can't reclaim the lease; a promoted
successor isn't loaded twice; a removed item isn't started by a delayed
fallback; failed incoming `prepare` retains the outgoing lease; restart
recovery preserves intent without autoplay. Property tests on `queue-ops.ts`
(shuffle preserves the multiset) and persisted-state round-trips. Move real
`setTimeout` waits to fake timers; commit shrunk counterexamples as
regression tests.

**Quint — small trial.** Model the lease/handoff/promotion protocol: two
routes, short queue, generations, `pendingPrefetch`, the promotion timer as
a nondeterministic race, `ended`/`started(promoted)`, queue edits, engine
restart. Either it justifies the 600 ms window (race unbounded without an
engine event — the fix is then a protocol addition) or it emits a
counterexample trace. TS replay is real: `@firfi/quint-connect` v2.1.0
(Fusion unpacked the tarball) runs `quint run --mbt`, parses ITF traces, and
replays through a user driver — usable via its plain Standard-Schema API as
a devDependency; its Effect API targets Effect 3 only, and its ITF helpers
need zod 4 (which is why zod won the schema slot). Fallback: `quint run
--out-itf` plus hand-written replay.

One invariant needs care — **"at most one audible route" is not guaranteed
today**: when `outgoing.stop` fails, the coordinator reports the error and
starts the incoming route anyway (deliberate: teardown failure must not
wedge the handoff, `coordinator.ts:554-556`). The spec should state it
conditionally — "at most one audible route unless a stop failure was
reported for the outgoing lease" — and the model may then argue for a cheap
fix: a best-effort `outgoing.setVolume(0)` in the catch block.

**Playwright-Electron — adopt now.** `import { _electron } from 'playwright'`
(the `@playwright/electron` split was reverted). Start with a packaged-app
smoke path: isolated `userData`, import a local fixture, play through the
Rust null sink, quit/relaunch, verify restored paused state. Kill the audio
child to test restart; drive `powerMonitor` suspend/resume via
`electronApp.evaluate`. Hidden provider `BrowserWindow`s should appear in
`electronApp.windows()` once loaded — match by `page.url()`, never index;
sign-in popups (`setWindowOpenHandler`, `show:true`) arrive via
`waitForEvent('window')`. Verify with a window-listing spike before relying
on it. Production builds must keep the `EnableNodeCliInspectArguments` fuse
enabled.

**Real-provider testing (goal 3).** Neither Effect nor Alchemy nor
record-replay reaches it. The actual answer: a credentialed, opt-in adapter
contract suite — dedicated real accounts driving `ProviderSession` against
live services, asserting controller `started`/`position`/`ended` events,
run nightly. Spotify needs Premium; Apple needs a subscription *and* the
unbuilt token endpoint. HAR record/replay helps only `youtubei.js` catalog
calls — useless for DRM streams and page behavior. Live runs stay mandatory:
only they catch selector, auth, and policy drift. Device loss needs
Rust-side fault injection plus a PipeWire node-removal script; nothing on
the list covers it.

## Ordered first steps (council-merged)

1. **CI + test-first defect repair.** Wire `verify.sh` into CI (there is
   none). Fix defects 1-3 with a failing fake-timer test each, then the
   plain-TS fix (timeout wrapper, prefetch generation token, `extendChain`
   helper). Watch the vitest version spread across packages (2.1 / 3.2 /
   5.0.5).
2. **fast-check command model + zod schemas** at `persisted-state.ts`,
   `ipc-validation.ts`, `parseLine` event params, `parseProviderQueue` —
   schemas add the `currentIndex` bounds and track-shape checks
   `isQueueState` lacks. Commit shrunk counterexamples as regressions.
3. **Playwright-Electron smoke** (packaged app, null sink, restore-on-
   relaunch) with a window-listing spike. **Then** the Quint handoff model
   once property tests run clean; credentialed provider suite last, opt-in.

## Council record

Round 1 (independent positions):

| Seat | Effect runtime | Schema | Alchemy | fast-check | Quint | PW-Electron | XState |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Terra | trial audio-client only | adopt (any lib) | later/trigger | adopt | trial | adopt | defer |
| SWE-2 | defer/trigger | adopt (Schema or valibot) | skip | adopt | trial | adopt | skip |
| Fusion | trial coordinator + Schema | — | skip | adopt | trial | adopt | skip |

Round 2 (cross-critique): Terra withdrew its audio-client trial and moved to
full defer; SWE-2 conceded the coordinator-rewrite argument and narrowed its
trial to audio-client; Fusion dropped its coordinator trial entirely and
accepted SWE-2's trigger. Schema converged on zod 4 (quint-connect synergy)
over Terra's valibot preference. Terra's conditional audible-route invariant
was accepted by both. Fusion verified `@firfi/quint-connect` exists
(Effect-3-bound API, plain Standard-Schema API usable without it), resolving
Terra's bridge doubt; SWE-2's Playwright window-by-URL guidance and Fusion's
fuse caveat were folded in.

**Movement summary:** three different Effect positions converged on *defer*,
with `audio-client.ts` as the designated trial site behind its Promise API.
Everything else was unanimous by round 2.

## Sources checked

- effect.website: v4.0 release notes (stable 2026-09-30, LTS to Sept 2029,
  ~7.1 kB min bundle, zero-dep core), v4.1 (2026-11-02), migration docs,
  TestClock docs.
- alchemy.run: what-is-alchemy, compare page, testing tutorials; npm
  `alchemy` v2.0.0-beta.85.
- Playwright: Electron API docs; PR #40184 (split) and revert #40733.
- Quint: quint.sh docs/FAQ/model-checkers; github.com/quint-co/quint-connect
  (Rust); npm `@firfi/quint-connect` v2.1.0 (TS port, unpacked and inspected).
- Real-world Effect-in-Electron: opencode PR #45774 (bundles Effect into
  Electron main), github.com/AdiRishi/electron-effect-starter.
- This repo: `docs/prototype-v1.md`, `docs/prototype-v2.md`,
  `docs/build-plan.md`, `coordinator.ts`, `persisted-state.ts`,
  `ipc-validation.ts`, `json-rpc.ts`, `audio-client.ts`,
  `provider-session.ts`, `result.ts`, `test/*`.
