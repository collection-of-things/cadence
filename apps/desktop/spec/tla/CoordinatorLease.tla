---- MODULE CoordinatorLease ----
(***************************************************************************)
(* Models the generation/lease gate in onAdapterEvent (coordinator.ts) and *)
(* queueId ownership.                                                      *)
(*                                                                         *)
(* The promises:                                                           *)
(*  - a stale generation or a foreign route can never move coordinator     *)
(*    state: position, queue advance, or the lease itself                  *)
(*  - while a lease is held, its queueId names an item of the queue        *)
(*  - the same `ended` (generation, queueId) is processed at most once     *)
(*                                                                         *)
(* The model tracks, for every mutable effect, WHICH generation produced   *)
(* it: posGen (last position event accepted) and advGen (last queue        *)
(* advance accepted). A lease mint clears both — the code's startItem      *)
(* clears handledEnded and loads fresh state under the new generation.     *)
(*                                                                         *)
(* GateOn chooses whether the event gate (e.generationId = lease.gen and   *)
(* route = lease.route) is enforced, mirroring coordinator.ts lines        *)
(* ~731-732. DedupeOn chooses whether handledEnded dedupes repeated        *)
(* `ended` events (lines ~772-774).                                        *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
    MaxGen,       \* bound on generation ids
    GateOn,       \* FALSE = mutation: the generation/route gate is removed
    DedupeOn      \* FALSE = mutation: handledEnded dedupe removed

Items == {"i1", "i2"}         \* queueIds in the (fixed) queue
NoLease == [g |-> 0, route |-> "none", qid |-> "none"]
Routes == {"local", "yt"}     \* two adapters; events may come from either
EventGens == 1..MaxGen        \* stamps an event can carry

VARIABLES
    gen,          \* coordinator generation counter
    lease,        \* NoLease or [g |-> Nat, route |-> Routes, qid |-> Items]
    posGen,       \* generation that last moved positionMs (0 = none)
    advGen,       \* generation that last advanced the queue (0 = none)
    advCount,     \* advances performed under the current lease
    endedSeen,    \* handledEnded: set of (gen, qid) already processed
    current       \* index into the 2-item queue

vars == <<gen, lease, posGen, advGen, advCount, endedSeen, current>>

HasLease == lease.g > 0

Init ==
    /\ gen = 0
    /\ lease = NoLease
    /\ posGen = 0
    /\ advGen = 0
    /\ advCount = 0
    /\ endedSeen = {}
    /\ current = 1

\* startItem commits a new lease: generation minted, handledEnded cleared,
\* position/advance provenance reset.
Mint(r, q) ==
    /\ gen < MaxGen
    /\ gen' = gen + 1
    /\ lease' = [g |-> gen + 1, route |-> r, qid |-> q]
    /\ posGen' = 0
    /\ advGen' = 0
    /\ advCount' = 0
    /\ endedSeen' = {}
    /\ UNCHANGED current

\* stop / teardown: lease released.
Stop ==
    /\ HasLease
    /\ lease' = NoLease
    /\ UNCHANGED <<gen, posGen, advGen, advCount, endedSeen, current>>

Gated(g, r) == HasLease /\ g = lease.g /\ r = lease.route

\* A `position` event. Gated: only the lease generation on the lease route
\* moves position. posGen records who moved it.
PositionEvent(g, r) ==
    IF GateOn => Gated(g, r)
    THEN /\ posGen' = g
         /\ UNCHANGED <<gen, lease, advGen, advCount, endedSeen, current>>
    ELSE UNCHANGED vars

\* An `ended` event. Gated AND deduped on (gen, qid); when accepted, the
\* queue advances and advGen records the producing generation.
EndedEvent(g, r, q) ==
    IF GateOn => Gated(g, r)
    THEN IF DedupeOn => <<g, q>> \notin endedSeen
         THEN /\ advGen' = g
              /\ advCount' = advCount + 1
              /\ endedSeen' = endedSeen \cup {<<g, q>>}
              /\ current' = IF current < 2 THEN current + 1 ELSE 1
              /\ UNCHANGED <<gen, lease, posGen>>
         ELSE UNCHANGED vars
    ELSE UNCHANGED vars

\* Any event from the environment at any time.
Event == \E g \in EventGens, r \in Routes, q \in Items :
            PositionEvent(g, r) \/ EndedEvent(g, r, q)

Done ==
    /\ gen = MaxGen
    /\ UNCHANGED vars

Next == Event \/ (\E r \in Routes, q \in Items : Mint(r, q)) \/ Stop \/ Done

Spec == Init /\ [][Next]_vars

\* SAFETY: whatever moved position did so under the live lease generation.
StalePositionNoEffect ==
    HasLease => posGen \in {0, lease.g}

\* SAFETY: whatever advanced the queue did so under the live lease
\* generation.
StaleEndedNoAdvance ==
    HasLease => advGen \in {0, lease.g}

\* SAFETY: a held lease names a queue item.
LeaseNamesItem ==
    HasLease => lease.qid \in Items

\* SAFETY: each accepted `ended` adds a fresh (gen, qid) key, so the number
\* of advances can never exceed the number of distinct ended events seen.
\* Without dedupe the same event can advance repeatedly.
EndedProcessedOnce == advCount <= Cardinality(endedSeen)
====
