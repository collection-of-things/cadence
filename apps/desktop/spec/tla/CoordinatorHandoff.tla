---- MODULE CoordinatorHandoff ----
(***************************************************************************)
(* Models the handoff + promotion protocol of coordinator.ts:              *)
(*                                                                         *)
(*   startItem:  mint lease -> prepare incoming -> stop outgoing ->        *)
(*               commit lease -> re-silence outgoing (cross-route) ->      *)
(*               play incoming -> issue prefetch                           *)
(*                                                                         *)
(*   events:     `ended`      -> arm 600ms promotion window when a         *)
(*                             prefetch is installed, else queue an        *)
(*                             advance link keyed on the ENDED item        *)
(*               `started`    -> engine self-promotion advances the queue  *)
(*               timer fire   -> queue the advance link (gen+qid check)    *)
(*                                                                         *)
(* Queue is fixed: 3 items, routes local/local/yt, repeat off.             *)
(*                                                                         *)
(* Constants pick the code shape under test:                               *)
(*  - PrefetchGuarded TRUE  = pendingPrefetch is written only when the     *)
(*    resolved prefetch still matches the live generation AND the current  *)
(*    successor (fixed code). FALSE = the buggy unconditional write.       *)
(*  - AdvanceGuarded TRUE   = a queued ended-advance re-checks the lease's *)
(*    (generation, queueId) when the link runs, before touching promotion  *)
(*    state (fixed code). FALSE = buggy code: a stale advance plays over   *)
(*    the user's chosen track.                                             *)
(*                                                                         *)
(* Properties:                                                             *)
(*  - SingleAudible: at most one route sounds — excluding per-route        *)
(*    reported stop failures and the awaited resile phase itself.          *)
(*  - StopBeforePlay: incoming play is only attempted after the outgoing   *)
(*    stop was attempted (when there is an outgoing engine).               *)
(*  - PrepareFailRollback: a failed prepare restores the index the         *)
(*    surviving lease names (not a remembered index).                      *)
(*  - PendingPrefetchSound: pendingPrefetch always names the successor     *)
(*    of the CURRENT item under the CURRENT generation.                    *)
(*  - NoStaleAdvance: an ended-driven advance never issues a real play     *)
(*    over a lease minted after it was queued.                             *)
(*  - NoMovedAdvance: an advance never runs a real start while the lease   *)
(*    names a different item than the track that ended — generation alone  *)
(*    cannot see a same-generation promotion.                              *)
(*  - AdvanceTargetSound: an advance that reaches a real play targets the  *)
(*    successor of the ENDED item, not a provisional index baked at        *)
(*    event time.                                                          *)
(*  - PlayingLeaseSound: settled and playing ⇒ the lease names the         *)
(*    current item or a known-foreign promotion (warn path).               *)
(*  - PlayingMeansSounding: settled and playing ⇒ a live lease whose       *)
(*    engine is sounding, or an advance is owed/armed/queued.              *)
(*  - StartCompletes / AdvanceTerminates (liveness).                       *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    MaxGen,           \* bound on generation ids
    MaxSteps,         \* bounded exploration: total actions per behavior
    MaxStarts,        \* bound on user-initiated starts
    PrefetchGuarded,  \* TRUE = fixed prefetch write guard
    AdvanceGuarded    \* TRUE = fixed stale-advance guard

Items == 1..3
ItemRoute == [i \in Items |-> IF i = 3 THEN "yt" ELSE "local"]
Succ == [i \in Items |-> IF i < 3 THEN i + 1 ELSE 0]   \* 0 = no successor
SuccOf(i) == IF i \in Items THEN Succ[i] ELSE 0

Routes == {"local", "yt"}
Gens == 1..MaxGen
NoLease == [g |-> 0, route |-> "none", qid |-> 0]
NoPf == [qid |-> 0, gen |-> 0, route |-> "none"]

VARIABLES
    generation,
    lease,          \* NoLease or [g |-> Gens, route |-> Routes, qid |-> Items+foreign]
    status,         \* "stopped" | "loading" | "playing" | "error" | "paused"
    currentIndex,   \* -1 or an item index
    active,         \* "none" or Routes (activeAdapter)
    sounding,       \* Routes -> BOOLEAN (engine actually audible)
    pendingPrefetch,\* NoPf or [qid, gen, route] — belief about installed prefetch
    inFlight,       \* issued prefetch calls awaiting resolution {recs}
    armedGen,       \* the 600ms promotion window: ended lease's gen (0 = off)
    armedQid,       \* and the ended item's queueId
    si,             \* the in-flight startItem record
    startQueue,     \* chain links waiting to run: <<[idx, advance, gen]>>
    userStarts,
    handledEnded,   \* dedupe set of <<gen, qid>>
    advanceDue,     \* an ended obligated an advance that hasn't completed
    stoppedBad,     \* routes whose stop teardown failure was reported
    staleStomp,     \* a stale advance link issued a real play — bug flag
    movedAdvance,   \* an advance ran a real start while the lease names a
                    \* different item than the ended track — bug flag
    stepCount       \* actions taken (bounded exploration)

vars == <<generation, lease, status, currentIndex, active, sounding,
          pendingPrefetch, inFlight, armedGen, armedQid, si, startQueue,
          userStarts, handledEnded,
          advanceDue, stoppedBad, staleStomp, movedAdvance, stepCount>>

InitSi ==
    [phase |-> "idle", idx |-> 0, advance |-> FALSE, issueGen |-> 0,
     cand |-> 0, route |-> "none", prevIdx |-> 0, prevLease |-> NoLease,
     endedQid |-> 0, outgoing |-> "none", stoppedOut |-> FALSE, stale |-> FALSE]

Init ==
    /\ generation = 0
    /\ lease = NoLease
    /\ status = "stopped"
    /\ currentIndex = -1
    /\ active = "none"
    /\ sounding = [r \in Routes |-> FALSE]
    /\ pendingPrefetch = NoPf
    /\ inFlight = {}
    /\ armedGen = 0
    /\ armedQid = 0
    /\ si = InitSi
    /\ startQueue = <<>>
    /\ userStarts = 0
    /\ handledEnded = {}
    /\ advanceDue = FALSE
    /\ stoppedBad = {}
    /\ staleStomp = FALSE
    /\ movedAdvance = FALSE
    /\ stepCount = 0

HasLease == lease.g > 0
Gated(g, r) == HasLease /\ g = lease.g /\ r = lease.route

\* -------------------------------------------------------------------------
\* User / chain side
\* -------------------------------------------------------------------------

\* A user start command appends a link; advance=FALSE, issueGen=0 (user
\* intent is never stale).
UserStart(i) ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ userStarts < MaxStarts
    /\ Len(startQueue) < 3
    /\ i \in Items
    /\ startQueue' = Append(startQueue, [idx |-> i, advance |-> FALSE, gen |-> 0,
                                         endedQid |-> 0])
    /\ userStarts' = userStarts + 1
    /\ UNCHANGED <<generation, lease, status, currentIndex, active, sounding,
                   pendingPrefetch, inFlight, armedGen, armedQid, si, handledEnded,
                   advanceDue, stoppedBad, staleStomp, movedAdvance>>

\* startItem head: clearPromotionWait + pendingPrefetch := null, then the
\* stale-advance check (fixed code only), the advance-promotion branch, or
\* the lease mint.
BeginStart ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "idle"
    /\ startQueue /= <<>>
    /\ LET req == Head(startQueue)
            \* ended-advance links carry the ENDED item's id; the target is
            \* recomputed at run time — a rolled-back provisional index
            \* must not redirect the advance (finding: prepare-fail + ended)
            target == IF req.endedQid /= 0 THEN Succ[req.endedQid] ELSE req.idx
            staleLink == req.advance /\ req.endedQid /= 0
                         /\ (req.gen /= lease.g \/ req.endedQid /= lease.qid)
            dueLeft == (armedGen /= 0)
                \/ \E i \in DOMAIN Tail(startQueue) : Tail(startQueue)[i].advance IN
        /\ startQueue' = Tail(startQueue)
        /\ IF target = 0
             THEN \* nothing to advance (ended item has no successor) —
                  \* the link resolves without touching promotion state
                  /\ si' = si
                  /\ advanceDue' = dueLeft
                  /\ UNCHANGED <<generation, lease, status, currentIndex,
                                 active, sounding, pendingPrefetch, armedGen,
                                 armedQid, inFlight, handledEnded,
                                 stoppedBad, staleStomp, movedAdvance>>
             ELSE IF /\ AdvanceGuarded /\ staleLink
                    THEN \* stale advance link: the lease no longer names
                         \* the ended track — skipped by the run-time check
                         \* inside the chain task, BEFORE startItem: the
                         \* promotion state must NOT be cleared here.
                         /\ si' = si
                         /\ advanceDue' = dueLeft
                         /\ UNCHANGED <<generation, lease, status, currentIndex,
                                        active, sounding, pendingPrefetch,
                                        armedGen, armedQid, inFlight,
                                        handledEnded, stoppedBad, staleStomp, movedAdvance>>
                    ELSE /\ armedGen' = 0    \* startItem: clearPromotionWait
                         /\ armedQid' = 0
                         /\ pendingPrefetch' = NoPf
                         \* real start: mint a candidate lease
                         /\ movedAdvance' = (movedAdvance \/
                                      (req.advance /\ req.endedQid /= 0
                                       /\ req.endedQid /= lease.qid))
                         /\ generation < MaxGen
                         /\ generation' = generation + 1
                         /\ si' = [phase |-> "prepare", idx |-> target,
                                             advance |-> req.advance,
                                             issueGen |-> req.gen,
                                             cand |-> generation + 1,
                                             route |-> ItemRoute[target],
                                             prevIdx |-> currentIndex,
                                             prevLease |-> lease,
                                             endedQid |-> req.endedQid,
                                             outgoing |-> "none",
                                             stoppedOut |-> FALSE,
                                             stale |-> staleLink]
                         /\ currentIndex' = target
                         /\ status' = "loading"
                         /\ advanceDue' = dueLeft
                         /\ UNCHANGED <<lease, active, sounding,
                                                  inFlight, handledEnded,
                                                  stoppedBad, staleStomp>>
    /\ UNCHANGED <<userStarts>>

\* adapter.prepare resolves: continue to teardown or roll back.
PrepareResolve ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "prepare"
    /\ \/ \* ok — decide whether there is an outgoing engine to silence
          /\ LET out == IF active /= "none" /\ active /= si.route /\ HasLease
                          THEN active ELSE "none" IN
               /\ si' = [si EXCEPT !.phase = IF out = "none" THEN "commit" ELSE "stopout",
                                   !.outgoing = out]
          /\ UNCHANGED <<generation, lease, status, currentIndex, active,
                         sounding, pendingPrefetch, inFlight, armedGen, armedQid,
                         startQueue, userStarts, handledEnded, advanceDue,
                         stoppedBad, staleStomp, movedAdvance>>
       \/ \* failed — restore index to whatever the lease names: if a
          \* self-promotion interleaved during prepare, the engine's truth
          \* wins; otherwise this equals the remembered previous index.
          /\ currentIndex' = IF lease.qid \in Items THEN lease.qid ELSE si.prevIdx
          /\ status' = "error"
          /\ si' = [si EXCEPT !.phase = "failed"]
          /\ advanceDue' = FALSE
          /\ UNCHANGED <<generation, lease, active, sounding, pendingPrefetch,
                         inFlight, armedGen, armedQid, startQueue, userStarts,
                         handledEnded, stoppedBad, staleStomp, movedAdvance>>

FailSettle == \* a failed start leaves the link; si returns to idle
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "failed"
    /\ si' = InitSi
    /\ UNCHANGED <<generation, lease, status, currentIndex, active, sounding,
                   pendingPrefetch, inFlight, armedGen, armedQid, startQueue,
                   userStarts, handledEnded, advanceDue, stoppedBad,
                   staleStomp, movedAdvance>>

\* outgoing.stop resolves: confirmed silent, or reported failure — the
\* handoff continues either way (deliberate).
StopOutResolve ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "stopout"
    /\ \/ \* silenced — also clears the route's failure exemption
          /\ sounding' = [sounding EXCEPT ![si.outgoing] = FALSE]
          /\ active' = "none"
          /\ stoppedBad' = stoppedBad \ {si.outgoing}
       \/ \* teardown failure is reported per-route but cannot wedge
          \* the handoff
          /\ stoppedBad' = stoppedBad \cup {si.outgoing}
          /\ UNCHANGED <<sounding, active>>
    /\ si' = [si EXCEPT !.phase = "commit", !.stoppedOut = TRUE]
    /\ UNCHANGED <<generation, lease, status, currentIndex, pendingPrefetch,
                   inFlight, armedGen, armedQid, startQueue, userStarts, handledEnded,
                   advanceDue, staleStomp, movedAdvance>>

\* The lease commit: handledEnded cleared, the candidate lease becomes
\* live, and (in the fixed code) the outgoing engine is re-silenced — a
\* self-promotion or late started from the just-stopped engine can
\* resurrect it during the earlier awaits, and the commit owns silence.
\* From this step the gate accepts the NEW generation.
CommitLease ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "commit"
    /\ lease' = [g |-> si.cand, route |-> si.route, qid |-> si.idx]
    /\ handledEnded' = {}
    \* re-assert intent: a self-promotion interleaving during the earlier
    \* awaits may have moved currentIndex — the committed item wins
    /\ currentIndex' = si.idx
    \* cross-route: the stopped outgoing may have resurrected (a
    \* self-promotion or late started during the awaits) — the re-stop is
    \* awaited before the incoming play
    /\ si' = [si EXCEPT !.phase = IF si.outgoing = "none" THEN "play" ELSE "resile"]
    /\ UNCHANGED <<generation, status, active, sounding, pendingPrefetch,
                   inFlight, armedGen, armedQid, startQueue, userStarts,
                   advanceDue, stoppedBad,
                   staleStomp, movedAdvance>>

\* The awaited re-silence of the outgoing engine: succeeds silently, or
\* fails and is reported per-route — the handoff continues either way.
ResilenceResolve ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "resile"
    /\ \/ \* the re-stop silences only the outgoing route — and clears its
          \* reported-failure exemption (a later successful stop proves the
          \* engine responds again)
          /\ sounding' = [sounding EXCEPT ![si.outgoing] = FALSE]
          /\ stoppedBad' = stoppedBad \ {si.outgoing}
       \/ /\ stoppedBad' = stoppedBad \cup {si.outgoing}
          /\ UNCHANGED sounding
    /\ si' = [si EXCEPT !.phase = "play"]
    /\ UNCHANGED <<generation, lease, status, currentIndex, active,
                   pendingPrefetch, inFlight, armedGen, armedQid, startQueue,
                   userStarts, handledEnded, advanceDue, staleStomp, movedAdvance>>

\* setFidelityMode + setVolume + play resolve: mark the adapter active and
\* issue the successor prefetch, or fail into cleanup + error.
PlayResolve ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "play"
    /\ \/ \* resolved — but only wins if the committed lease still stands:
          \* an `ended` during the play await can tear the session down; a
          \* stale resolve must not claim playback over it.
          IF lease.g = si.cand
          THEN /\ active' = si.route
               /\ sounding' = [sounding EXCEPT ![si.route] = TRUE]
               /\ status' = "playing"
               /\ staleStomp' = (staleStomp \/ si.stale)
               /\ UNCHANGED movedAdvance
               /\ advanceDue' = FALSE
               /\ si' = InitSi
               /\ \* issue successor prefetch when it shares the route
                  IF /\ Succ[si.idx] /= 0
                     /\ ItemRoute[Succ[si.idx]] = si.route
                     /\ Cardinality(inFlight) < 1
                    THEN inFlight' = inFlight \cup
                                      {[qid |-> Succ[si.idx], gen |-> si.cand,
                                        route |-> si.route]}
                    ELSE UNCHANGED inFlight
               /\ UNCHANGED <<generation, lease, currentIndex,
                              pendingPrefetch, armedGen, armedQid, startQueue,
                              userStarts, handledEnded, stoppedBad>>
          ELSE \* stale resolve: silence the detached item, claim nothing
               /\ sounding' = [sounding EXCEPT ![si.route] = FALSE]
               /\ si' = InitSi
               /\ UNCHANGED <<generation, lease, status, currentIndex,
                              active, pendingPrefetch, inFlight, armedGen, armedQid,
                              startQueue, userStarts, handledEnded,
                              advanceDue, stoppedBad,
                              staleStomp, movedAdvance>>
       \/ \* failed — cleanup stop owns silence, error reported, and the
          \* lease is RELEASED: the gate dies with the attempt so a late
          \* `started` can't resurrect "playing" over the error.
          /\ sounding' = [sounding EXCEPT ![si.route] = FALSE]
          /\ status' = "error"
          /\ lease' = NoLease
          /\ active' = "none"
          /\ si' = InitSi
          /\ advanceDue' = FALSE
          /\ UNCHANGED <<generation, currentIndex,
                         pendingPrefetch, inFlight, armedGen, armedQid, startQueue,
                         userStarts, handledEnded, stoppedBad,
                         staleStomp, movedAdvance>>

\* -------------------------------------------------------------------------
\* Environment: adapter events, promotion timer, prefetch resolution
\* -------------------------------------------------------------------------

\* `ended` from the engine. Gated to the live lease and deduped.
EngineEnded ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase /= "failed"  \* the fail path is synchronous
    /\ HasLease
    /\ sounding[lease.route]  \* only a sounding track can end
    /\ \E q \in {lease.qid} :
        /\ <<lease.g, q>> \notin handledEnded
        /\ handledEnded' = handledEnded \cup {<<lease.g, q>>}
        /\ sounding' = [sounding EXCEPT ![lease.route] = FALSE]
        /\ LET succ == IF lease.qid \in Items THEN Succ[lease.qid] ELSE 0 IN
            IF succ = 0
            THEN /\ status' = "stopped"
                 /\ lease' = NoLease
                 /\ active' = "none"
                 /\ advanceDue' = FALSE
                 /\ UNCHANGED <<armedGen, armedQid, startQueue>>
            ELSE /\ IF pendingPrefetch.qid /= 0
                      THEN /\ armedGen' = lease.g
                           /\ armedQid' = lease.qid
                           /\ advanceDue' = TRUE   \* armed window owes it
                           /\ UNCHANGED startQueue
                      ELSE /\ UNCHANGED <<armedGen, armedQid>>
                           /\ IF Len(startQueue) < 3
                                THEN /\ startQueue' = Append(startQueue,
                                        [idx |-> 0, advance |-> TRUE,
                                         gen |-> lease.g,
                                         endedQid |-> lease.qid])
                                     /\ advanceDue' = TRUE
                                ELSE /\ UNCHANGED startQueue
                                     \* bounded queue dropped the link —
                                     \* no obligation outstanding
                                     /\ advanceDue' = FALSE
                 /\ UNCHANGED <<status, lease, active>>
    /\ UNCHANGED <<generation, currentIndex, pendingPrefetch, inFlight, si,
                   userStarts, stoppedBad, staleStomp, movedAdvance>>

\* `started` for the loaded item — confirms playback. (Promoted starts are
\* EnginePromoted below.)
EngineStarted ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase /= "failed"  \* the fail path is synchronous
    /\ HasLease
    /\ ~sounding[lease.route]
    /\ status' = "playing"
    /\ sounding' = [sounding EXCEPT ![lease.route] = TRUE]
    /\ UNCHANGED <<generation, lease, currentIndex, active,
                   pendingPrefetch, inFlight, armedGen, armedQid, si, startQueue,
                   userStarts, handledEnded, advanceDue, stoppedBad,
                   staleStomp, movedAdvance>>

\* Engine self-promotion: a started whose queueId is not the lease's.
\* promoteTrack advances queue intent with no play call.
EnginePromoted(q) ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase /= "failed"  \* the fail path is synchronous
    /\ HasLease
    \* self-promotion is a boundary event: it can only surface inside the
    \* promotion window, while an advance is due, or mid-handoff
    /\ (armedGen /= 0 \/ advanceDue \/ si.phase /= "idle")
    /\ q \in Items \cup {9}   \* 9 = foreign queueId (warn path)
    /\ q /= lease.qid
    /\ (q = pendingPrefetch.qid \/ q = SuccOf(currentIndex) \/ q = 9)
    /\ armedGen' = 0
        /\ armedQid' = 0
    /\ pendingPrefetch' = NoPf
    /\ advanceDue' = FALSE
    /\ sounding' = [sounding EXCEPT ![lease.route] = TRUE]
    /\ IF q \in Items
         THEN /\ currentIndex' = q
              /\ lease' = [lease EXCEPT !.qid = q]
              /\ status' = "playing"
              /\ \* re-prefetch the new successor on the same engine
                 IF /\ Succ[q] /= 0
                    /\ ItemRoute[Succ[q]] = lease.route
                    /\ Cardinality(inFlight) < 1
                   THEN inFlight' = inFlight \cup
                                     {[qid |-> Succ[q], gen |-> lease.g,
                                       route |-> lease.route]}
                   ELSE UNCHANGED inFlight
         ELSE IF pendingPrefetch.qid /= 0
               THEN \* code fallback: unknown id + installed prefetch ⇒
                    \* promote the prefetched item
                    /\ currentIndex' = pendingPrefetch.qid
                    /\ lease' = [lease EXCEPT !.qid = pendingPrefetch.qid]
                    /\ status' = "playing"
                    /\ UNCHANGED inFlight
               ELSE /\ lease' = [lease EXCEPT !.qid = q]  \* warn path
                    /\ UNCHANGED <<currentIndex, status, inFlight>>
    /\ UNCHANGED <<generation, active, si, startQueue, userStarts,
                   handledEnded, stoppedBad, staleStomp, movedAdvance>>

\* The 600ms promotion window elapses without a self-promoted started:
\* queue the advance-promotion fallback for the CURRENT successor.
TimerFire ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase /= "failed"  \* the fail path is synchronous
    /\ armedGen /= 0
    /\ armedGen' = 0
    /\ armedQid' = 0
    /\ pendingPrefetch' = NoPf
    \* staleness checked at fire too: the lease must still name the ended
    \* track before an advance link is even queued
    /\ IF lease.g = armedGen /\ lease.qid = armedQid
         THEN IF Len(startQueue) < 3
                THEN startQueue' = Append(startQueue,
                        [idx |-> 0, advance |-> TRUE, gen |-> armedGen,
                         endedQid |-> armedQid])
                ELSE UNCHANGED startQueue
         ELSE UNCHANGED startQueue
    /\ UNCHANGED <<generation, lease, status, currentIndex, active, sounding,
                   inFlight, si, userStarts, handledEnded, advanceDue, stoppedBad,
                   staleStomp, movedAdvance>>

\* A prefetch call resolves. The buggy code records it unconditionally;
\* the fix records it only while it still describes the live successor.
PrefetchResolve ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase /= "failed"  \* the fail path is synchronous
    /\ \E op \in inFlight :
        /\ inFlight' = inFlight \ {op}
        /\ IF PrefetchGuarded
             THEN IF /\ op.gen = generation
                     /\ op.qid = SuccOf(currentIndex)
                     /\ op.route = active
                    THEN pendingPrefetch' = op
                    ELSE UNCHANGED pendingPrefetch
             ELSE pendingPrefetch' = op
    /\ UNCHANGED <<generation, lease, status, currentIndex, active, sounding,
                   armedGen, armedQid, si, startQueue, userStarts, handledEnded,
                   advanceDue,
                   stoppedBad, staleStomp, movedAdvance>>

\* Bound artifact: when generation ids are exhausted a queued link can
\* never mint — discard it so the checker can reach quiescence.
DropStart ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "idle"
    /\ startQueue /= <<>>
    /\ generation = MaxGen
    /\ startQueue' = Tail(startQueue)
    /\ advanceDue' = FALSE  \* the bound artifact abandons the obligation
    /\ UNCHANGED <<generation, lease, status, currentIndex, active, sounding,
                   pendingPrefetch, inFlight, armedGen, armedQid, si, userStarts,
                   handledEnded, stoppedBad, staleStomp, movedAdvance>>

\* Quiescent terminal: nothing pending on the coordinator side, user
\* commands exhausted, and either no lease is held or the engine has
\* nothing new to say (its ended is deduped and playback is confirmed).
Done ==
    \/ /\ stepCount = MaxSteps          \* bound reached — behavior truncated
       /\ UNCHANGED vars
    \/ \* coordinator-side quiescence: no pending obligations. The engine
       \* may still have events in flight — bounded runs may stop here.
       /\ si.phase = "idle"
       /\ startQueue = <<>>
       /\ armedGen = 0
       /\ ~advanceDue
       /\ inFlight = {}
       /\ userStarts = MaxStarts
       /\ UNCHANGED vars

Next ==
    \/ (\E i \in Items : UserStart(i))
    \/ DropStart \/ Done
    \/ BeginStart \/ PrepareResolve \/ FailSettle \/ StopOutResolve
    \/ CommitLease \/ ResilenceResolve \/ PlayResolve
    \/ EngineEnded \/ EngineStarted \/ (\E q \in Items \cup {9} : EnginePromoted(q))
    \/ TimerFire \/ PrefetchResolve

FairActions ==
    /\ WF_vars(BeginStart)
    /\ WF_vars(PrepareResolve)
    /\ WF_vars(FailSettle)
    /\ WF_vars(StopOutResolve)
    /\ WF_vars(CommitLease)
    /\ WF_vars(ResilenceResolve)
    /\ WF_vars(PlayResolve)
    /\ WF_vars(TimerFire)
    /\ WF_vars(PrefetchResolve)
    /\ WF_vars(DropStart)

Spec == Init /\ [][Next]_vars /\ FairActions

\* -------------------------------------------------------------------------
\* Properties
\* -------------------------------------------------------------------------

\* At most one route sounds — excluding routes whose stop teardown
\* failure was reported (per-route), and the resile phase: while the
\* awaited re-stop of the outgoing engine is in flight, the incoming
\* engine may already report `started`. Any dual-sounding that survives
\* the phase is still a violation.
SingleAudible ==
    si.phase /= "resile" =>
        (Cardinality({r \in Routes : sounding[r]} \ stoppedBad) <= 1)

\* Incoming play is attempted only after outgoing teardown was attempted.
StopBeforePlay ==
    si.phase \in {"commit", "resile", "play"} => (si.outgoing = "none" \/ si.stoppedOut)

\* A failed prepare restores the index the (possibly re-pointed) lease
\* names. A self-promotion interleaving during prepare moves the lease to
\* the engine's real track — the rollback must follow it.
PrepareFailRollback ==
    si.phase = "failed" => (lease.qid \in Items => currentIndex = lease.qid)

\* pendingPrefetch always names the successor of the CURRENT item under the
\* CURRENT generation — the belief the ended handler and promoteTrack use.
PendingPrefetchSound ==
    pendingPrefetch.qid /= 0 =>
        (pendingPrefetch.qid = SuccOf(currentIndex)
         /\ pendingPrefetch.gen = generation)

\* An ended-driven advance may advance a promotion but must never issue a
\* real play over a lease minted after it was queued.
NoStaleAdvance == ~staleStomp

\* An advance may not run a real start while the lease names a different
\* item than the track that ended — the generation alone cannot see a
\* same-generation promotion (finding: stale advance by gen-only check).
NoMovedAdvance == ~movedAdvance

\* While playing with no handoff in flight, the lease names the current
\* item — unless the engine promoted a foreign queueId (deliberate warn
\* path). Mid-startItem a started for the still-live old lease can set
\* status=playing while currentIndex already moved; that flicker is
\* transient and deliberate, so the check is scoped to settled states.
PlayingLeaseSound ==
    (status = "playing" /\ si.phase = "idle") =>
        (lease.qid = currentIndex \/ (HasLease /\ lease.qid \notin Items))

\* "playing" claims output: a live lease whose engine is actually
\* sounding — no phantom playback. Exception: the ended→advance window,
\* where the engine just went silent and an advance is owed or the
\* promotion window is armed (status stays "playing" by design until the
\* next start lands).
advancePending ==
    advanceDue \/ armedGen /= 0
    \/ \E i \in DOMAIN startQueue : startQueue[i].advance

PlayingMeansSounding ==
    (status = "playing" /\ si.phase = "idle") =>
        (HasLease /\ (sounding[lease.route] \/ advancePending))

\* An ended-advance that reached a real play must target the successor of
\* the ENDED item — not a provisional index baked at event time.
AdvanceTargetSound ==
    si.phase \in {"prepare", "stopout", "commit", "resile", "play"} /\
    si.advance /\ si.endedQid /= 0 =>
        si.idx = Succ[si.endedQid]

\* LIVENESS: a started handoff always settles — unless the exploration
\* bound truncated the behavior (bounded checking: a counterexample that
\* only fails at stepCount = MaxSteps says nothing about the code).
StartCompletes ==
    si.phase /= "idle" ~> (si.phase = "idle" \/ stepCount = MaxSteps)

\* LIVENESS: every ended-obligated advance resolves (advance, play, drop).
AdvanceTerminates == advanceDue ~> (~advanceDue \/ stepCount = MaxSteps)
====
