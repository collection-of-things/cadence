# Extend the helper

1. Read the closest flow and `helpers/src/lib/flow.mjs`. Add
   `helpers/src/flows/<name>.mjs` exporting `name` and async `run(ctx)`, then add
   its lazy import to `FLOWS` in `helpers/src/cli.mjs`. Registration is explicit.
2. Use `ctx.page`, `ev`, `pw`, `meta`, `ud`, `runDir`, `breaks` and, for managed
   sessions, `app` and `tracked`. Attach has no managed lifecycle handle or
   recorder registry. Register managed recorders and stop captures in `finally`
   so failures release resources in both modes.
3. Drive the UI for the behavior under test and assert its expected result.
   Scope transport buttons with `transportButton`, since page-wide Play can
   match Playlists. Use `seedLibrary` for fixture identity checks and local
   platform setup. Pair navigation with destination visibility; use predicate
   waits for asynchronous mutations. Label bridge-only operations as such.
4. For local audio, `assertAudioRouted` wires and checks the stream in the private
   core; `analyzeCapture` validates analyzer completion/schema/required check
   names before replaying results. Record the sink's monitor, not app output
   ports. Provider audio requires proving the stream belongs to this app tree.
5. Keep contract assertions required. Use `{ required: false }` only for an
   explicitly documented observation or coverage limitation. Add an applicable
   negative control to `BREAKS`, managed `breakFlows` validation and the flow.
6. Run `selftest`, the changed positive flow, and its applicable negative
   control. Add regression tests when behavior changes: isolation/profile and
   process safety in `isolation.test.mjs`, interrupted cleanup in
   `lifecycle.test.mjs`, verdict semantics in `evidence.test.mjs`, restore
   clauses in `restart-oracle.test.mjs`, analyzer input/negative cases in
   `analyze.test.mjs`.
7. Update the flow guide and skill's flow table with actual assertions,
   prerequisites, evidence names and gaps. Completion requires a normal PASS
   plus an intended negative-control FAIL, or an explicit blocker with evidence.

For coordinator, persistence or adapter event changes, also follow
[coordinator formal verification](../../coordinator-tla-verify/SKILL.md).
Formal models, replay tests and real Electron evidence complement each other;
none proves all three contracts.
