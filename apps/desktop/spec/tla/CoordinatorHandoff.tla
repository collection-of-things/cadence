---- MODULE CoordinatorHandoff ----
(***************************************************************************)
(* Models the handoff + promotion protocol of coordinator.ts:              *)
(*                                                                         *)
(*   startItem:  mint lease -> prepare incoming -> stop outgoing ->        *)
(*               play incoming -> commit lease -> issue prefetch           *)
(*                                                                         *)
(*   events:     `ended`      -> arm 600ms promotion window when a         *)
(*                             prefetch is installed, else queue an        *)
(*                             adopt-promotion start                       *)
(*               `started`    -> engine self-promotion advances the queue  *)
(*               timer fire   -> queue the adopt-promotion start           *)
(*                                                                         *)
(* Queue is fixed: 3 items, routes local/local/yt, repeat off.             *)
(*                                                                         *)
(* Constants pick the code shape under test:                               *)
(*  - PrefetchGuarded TRUE  = pendingPrefetch is written only when the     *)
(*    resolved prefetch still matches the live generation AND the current  *)
(*    successor (fixed code). FALSE = the buggy unconditional write.       *)
(*  - AdvanceGuarded TRUE   = a queued ended-advance re-checks the lease   *)
(*    generation when the link runs (fixed code). FALSE = buggy code,      *)
(*    where a stale advance plays over the user's chosen track.            *)
(*                                                                         *)
(* Properties:                                                             *)
(*  - SingleAudible: at most one route sounds, unless an outgoing-stop     *)
(*    failure was reported (deliberate code exception).                    *)
(*  - StopBeforePlay: incoming play is only attempted after the outgoing   *)
(*    stop was attempted (when there is an outgoing engine).               *)
(*  - PrepareFailRollback: a failed prepare restores the previous index    *)
(*    and leaves the outgoing lease untouched.                             *)
(*  - PendingPrefetchSound: pendingPrefetch always names the successor     *)
(*    of the CURRENT item under the CURRENT generation.                    *)
(*  - NoStaleAdvance: an ended-driven advance never plays over a lease     *)
(*    minted after it was queued.                                          *)
(*  - AdoptedWhenEligible: a start the engine already satisfies via a    *)
(*    self-promotion must adopt the lease, never re-play the track.      *)
(*  - PlayingLeaseSound: while playing, the lease names the current item — *)
(*    unless the engine promoted a foreign track (warn path).              *)
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
    timerArmed,     \* the 600ms promotion window
    si,             \* the in-flight startItem record
    startQueue,     \* chain links waiting to run: <<[idx, adopt, gen]>>
    userStarts,
    handledEnded,   \* dedupe set of <<gen, qid>>
    promotedQid,    \* 0 or item index (promotedQueueId)
    promotedGen,
    adoptMissed,    \* an adopt-eligible start took the real-play path
    advanceDue,     \* an ended obligated an advance that hasn't completed
    stopFailed,     \* an outgoing stop failure was reported
    foreignPromo,   \* engine promoted a queueId we don't know (warn path)
    staleStomp,     \* a stale advance link issued a real play — bug flag
    stepCount       \* actions taken (bounded exploration)

vars == <<generation, lease, status, currentIndex, active, sounding,
          pendingPrefetch, inFlight, timerArmed, si, startQueue,
          userStarts, handledEnded, promotedQid, promotedGen, adoptMissed,
          advanceDue, stopFailed, foreignPromo, staleStomp, stepCount>>

InitSi ==
    [phase |-> "idle", idx |-> 0, adopt |-> FALSE, issueGen |-> 0,
     cand |-> 0, route |-> "none", prevIdx |-> 0, prevLease |-> NoLease,
     outgoing |-> "none", stoppedOut |-> FALSE, stale |-> FALSE]

Init ==
    /\ generation = 0
    /\ lease = NoLease
    /\ status = "stopped"
    /\ currentIndex = -1
    /\ active = "none"
    /\ sounding = [r \in Routes |-> FALSE]
    /\ pendingPrefetch = NoPf
    /\ inFlight = {}
    /\ timerArmed = FALSE
    /\ si = InitSi
    /\ startQueue = <<>>
    /\ userStarts = 0
    /\ handledEnded = {}
    /\ promotedQid = 0
    /\ promotedGen = 0
    /\ adoptMissed = FALSE
    /\ advanceDue = FALSE
    /\ stopFailed = FALSE
    /\ foreignPromo = FALSE
    /\ staleStomp = FALSE
    /\ stepCount = 0

HasLease == lease.g > 0
Gated(g, r) == HasLease /\ g = lease.g /\ r = lease.route

\* -------------------------------------------------------------------------
\* User / chain side
\* -------------------------------------------------------------------------

\* A user start command appends a link; adopt=FALSE, issueGen=0 (user
\* intent is never stale).
UserStart(i) ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ userStarts < MaxStarts
    /\ Len(startQueue) < 3
    /\ i \in Items
    /\ startQueue' = Append(startQueue, [idx |-> i, adopt |-> FALSE, gen |-> 0])
    /\ userStarts' = userStarts + 1
    /\ UNCHANGED <<generation, lease, status, currentIndex, active, sounding,
                   pendingPrefetch, inFlight, timerArmed, si, handledEnded,
                   promotedQid, promotedGen, adoptMissed,
                   advanceDue, stopFailed, foreignPromo, staleStomp>>

\* startItem head: clearPromotionWait + pendingPrefetch := null, then the
\* stale-advance check (fixed code only), the adopt-promotion branch, or
\* the lease mint.
BeginStart ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "idle"
    /\ startQueue /= <<>>
    /\ LET req == Head(startQueue) IN
        /\ startQueue' = Tail(startQueue)
        /\ timerArmed' = FALSE
        /\ pendingPrefetch' = NoPf
        /\ IF /\ req.adopt
              /\ AdvanceGuarded
              /\ req.gen /= lease.g      \* the ended that queued this is stale
             THEN \* stale advance link: skip entirely — the user moved on
                  /\ si' = si
                  /\ advanceDue' = FALSE
                  /\ UNCHANGED <<generation, lease, status, currentIndex,
                                 active, sounding, inFlight, handledEnded,
                                 promotedQid, promotedGen, adoptMissed,
                                 stopFailed, foreignPromo, staleStomp>>
             ELSE IF /\ req.adopt
                     /\ promotedQid = req.idx
                     /\ active = ItemRoute[req.idx]
                     /\ <<promotedGen, req.idx>> \notin handledEnded
                    THEN \* adopt the self-promoted lease — no play call
                         /\ si' = si
                         /\ currentIndex' = req.idx
                         /\ status' = "playing"
                         /\ advanceDue' = FALSE
                         /\ UNCHANGED <<generation, lease, active, sounding,
                                        inFlight, handledEnded, promotedQid,
                                        promotedGen, adoptMissed,
                                        stopFailed, foreignPromo, staleStomp>>
                    ELSE \* real start: mint a candidate lease
                         /\ adoptMissed' = (adoptMissed \/
                            (req.adopt /\ promotedQid = req.idx
                             /\ active = ItemRoute[req.idx]
                             /\ <<promotedGen, req.idx>> \notin handledEnded))
                         /\ generation < MaxGen
                         /\ generation' = generation + 1
                         /\ si' = [phase |-> "prepare", idx |-> req.idx,
                                   adopt |-> req.adopt, issueGen |-> req.gen,
                                   cand |-> generation + 1,
                                   route |-> ItemRoute[req.idx],
                                   prevIdx |-> currentIndex,
                                   prevLease |-> lease,
                                   outgoing |-> "none", stoppedOut |-> FALSE,
                                   stale |-> (req.adopt /\ req.gen /= 0
                                              /\ req.gen /= lease.g)]
                         /\ currentIndex' = req.idx
                         /\ status' = "loading"
                         /\ UNCHANGED <<lease, active, sounding, inFlight,
                                        handledEnded, promotedQid,
                                        promotedGen, advanceDue, stopFailed,
                                        foreignPromo, staleStomp>>
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
                         sounding, pendingPrefetch, inFlight, timerArmed,
                         startQueue, userStarts, handledEnded, promotedQid,
                         promotedGen, adoptMissed, advanceDue,
                         stopFailed, foreignPromo, staleStomp>>
       \/ \* failed — restore index to whatever the lease names: if a
          \* self-promotion interleaved during prepare, the engine's truth
          \* wins; otherwise this equals the remembered previous index.
          /\ currentIndex' = IF lease.qid \in Items THEN lease.qid ELSE si.prevIdx
          /\ status' = "error"
          /\ si' = [si EXCEPT !.phase = "failed"]
          /\ advanceDue' = FALSE
          /\ UNCHANGED <<generation, lease, active, sounding, pendingPrefetch,
                         inFlight, timerArmed, startQueue, userStarts,
                         handledEnded, promotedQid, promotedGen, adoptMissed,
                         stopFailed, foreignPromo, staleStomp>>

FailSettle == \* a failed start leaves the link; si returns to idle
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "failed"
    /\ si' = InitSi
    /\ UNCHANGED <<generation, lease, status, currentIndex, active, sounding,
                   pendingPrefetch, inFlight, timerArmed, startQueue,
                   userStarts, handledEnded, promotedQid, promotedGen,
                   adoptMissed, advanceDue, stopFailed, foreignPromo,
                   staleStomp>>

\* outgoing.stop resolves: confirmed silent, or reported failure — the
\* handoff continues either way (deliberate).
StopOutResolve ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase = "stopout"
    /\ \/ \* silenced
          /\ sounding' = [sounding EXCEPT ![si.outgoing] = FALSE]
          /\ active' = "none"
          /\ UNCHANGED stopFailed
       \/ \* teardown failure is reported but cannot wedge the handoff
          /\ stopFailed' = TRUE
          /\ UNCHANGED <<sounding, active>>
    /\ si' = [si EXCEPT !.phase = "commit", !.stoppedOut = TRUE]
    /\ UNCHANGED <<generation, lease, status, currentIndex, pendingPrefetch,
                   inFlight, timerArmed, startQueue, userStarts, handledEnded,
                   promotedQid, promotedGen, adoptMissed, advanceDue,
                   foreignPromo, staleStomp>>

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
    /\ promotedQid' = 0
    \* re-assert intent: a self-promotion interleaving during the earlier
    \* awaits may have moved currentIndex — the committed item wins
    /\ currentIndex' = si.idx
    /\ sounding' = IF si.outgoing = "none"
                    THEN sounding   \* same-route: old track still plays
                    ELSE [r \in Routes |-> FALSE]  \* re-stop covers resurrection
    /\ si' = [si EXCEPT !.phase = "play"]
    /\ UNCHANGED <<generation, status, active, pendingPrefetch, inFlight,
                   timerArmed, startQueue, userStarts, promotedGen,
                   adoptMissed, advanceDue, stopFailed, foreignPromo,
                   staleStomp>>

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
                              pendingPrefetch, timerArmed, startQueue,
                              userStarts, handledEnded, promotedQid,
                              promotedGen, adoptMissed, stopFailed,
                              foreignPromo>>
          ELSE \* stale resolve: silence the detached item, claim nothing
               /\ sounding' = [sounding EXCEPT ![si.route] = FALSE]
               /\ si' = InitSi
               /\ UNCHANGED <<generation, lease, status, currentIndex,
                              active, pendingPrefetch, inFlight, timerArmed,
                              startQueue, userStarts, handledEnded,
                              promotedQid, promotedGen, adoptMissed,
                              advanceDue, stopFailed, foreignPromo,
                              staleStomp>>
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
                         pendingPrefetch, inFlight, timerArmed, startQueue,
                         userStarts, handledEnded, promotedQid, promotedGen,
                         adoptMissed, stopFailed, foreignPromo,
                         staleStomp>>

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
        /\ LET succ == SuccOf(currentIndex) IN
            IF succ = 0
            THEN /\ status' = "stopped"
                 /\ lease' = NoLease
                 /\ active' = "none"
                 /\ advanceDue' = FALSE
                 /\ UNCHANGED <<timerArmed, startQueue>>
            ELSE /\ advanceDue' = TRUE
                 /\ IF pendingPrefetch.qid /= 0
                      THEN /\ timerArmed' = TRUE
                           /\ UNCHANGED startQueue
                      ELSE /\ timerArmed' = timerArmed
                           /\ IF Len(startQueue) < 3
                                THEN startQueue' = Append(startQueue,
                                        [idx |-> succ, adopt |-> TRUE,
                                         gen |-> lease.g])
                                ELSE UNCHANGED startQueue
                 /\ UNCHANGED <<status, lease, active>>
    /\ UNCHANGED <<generation, currentIndex, pendingPrefetch, inFlight, si,
                   userStarts, promotedQid, promotedGen, adoptMissed,
                   stopFailed, foreignPromo, staleStomp>>

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
                   pendingPrefetch, inFlight, timerArmed, si, startQueue,
                   userStarts, handledEnded, promotedQid, promotedGen,
                   adoptMissed, advanceDue, stopFailed, foreignPromo,
                   staleStomp>>

\* Engine self-promotion: a started whose queueId is not the lease's.
\* promoteTrack advances queue intent with no play call.
EnginePromoted(q) ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase /= "failed"  \* the fail path is synchronous
    /\ HasLease
    \* self-promotion is a boundary event: it can only surface inside the
    \* promotion window, while an advance is due, or mid-handoff
    /\ (timerArmed \/ advanceDue \/ si.phase /= "idle")
    /\ q \in Items \cup {9}   \* 9 = foreign queueId (warn path)
    /\ q /= lease.qid
    /\ (q = pendingPrefetch.qid \/ q = SuccOf(currentIndex) \/ q = 9)
    /\ timerArmed' = FALSE
    /\ pendingPrefetch' = NoPf
    /\ advanceDue' = FALSE
    /\ sounding' = [sounding EXCEPT ![lease.route] = TRUE]
    /\ IF q \in Items
         THEN /\ currentIndex' = q
              /\ lease' = [lease EXCEPT !.qid = q]
              /\ promotedQid' = q
              /\ promotedGen' = lease.g
              /\ status' = "playing"
              /\ \* re-prefetch the new successor on the same engine
                 IF /\ Succ[q] /= 0
                    /\ ItemRoute[Succ[q]] = lease.route
                    /\ Cardinality(inFlight) < 1
                   THEN inFlight' = inFlight \cup
                                     {[qid |-> Succ[q], gen |-> lease.g,
                                       route |-> lease.route]}
                   ELSE UNCHANGED inFlight
              /\ UNCHANGED <<foreignPromo, adoptMissed>>
         ELSE /\ lease' = [lease EXCEPT !.qid = q]  \* keep lease on playing track
              /\ foreignPromo' = TRUE
              /\ UNCHANGED <<currentIndex, promotedQid, promotedGen,
                             adoptMissed, status, inFlight>>
    /\ UNCHANGED <<generation, active, si, startQueue, userStarts,
                   handledEnded, stopFailed, staleStomp>>

\* The 600ms promotion window elapses without a self-promoted started:
\* queue the adopt-promotion fallback for the CURRENT successor.
TimerFire ==
    /\ stepCount < MaxSteps
    /\ stepCount' = stepCount + 1
    /\ si.phase /= "failed"  \* the fail path is synchronous
    /\ timerArmed
    /\ timerArmed' = FALSE
    /\ pendingPrefetch' = NoPf
    /\ LET succ == SuccOf(currentIndex) IN
        /\ succ /= 0
        /\ IF Len(startQueue) < 3
             THEN startQueue' = Append(startQueue,
                     [idx |-> succ, adopt |-> TRUE, gen |-> lease.g])
             ELSE UNCHANGED startQueue
    /\ UNCHANGED <<generation, lease, status, currentIndex, active, sounding,
                   inFlight, si, userStarts, handledEnded, promotedQid,
                   promotedGen, adoptMissed, advanceDue, stopFailed,
                   foreignPromo, staleStomp>>

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
                   timerArmed, si, startQueue, userStarts, handledEnded,
                   promotedQid, promotedGen, adoptMissed, advanceDue,
                   stopFailed, foreignPromo, staleStomp>>

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
                   pendingPrefetch, inFlight, timerArmed, si, userStarts,
                   handledEnded, promotedQid, promotedGen, adoptMissed, stopFailed,
                   foreignPromo, staleStomp>>

\* Quiescent terminal: nothing pending on the coordinator side, user
\* commands exhausted, and either no lease is held or the engine has
\* nothing new to say (its ended is deduped and playback is confirmed).
Done ==
    \/ /\ stepCount = MaxSteps          \* bound reached — behavior truncated
       /\ UNCHANGED vars
    \/ /\ si.phase = "idle"
       /\ startQueue = <<>>
       /\ ~timerArmed
       /\ ~advanceDue
       /\ inFlight = {}
       /\ userStarts = MaxStarts
       /\ IF HasLease
           THEN /\ sounding[lease.route]
                /\ <<lease.g, lease.qid>> \in handledEnded
           ELSE TRUE
       /\ UNCHANGED vars

Next ==
    \/ (\E i \in Items : UserStart(i))
    \/ DropStart \/ Done
    \/ BeginStart \/ PrepareResolve \/ FailSettle \/ StopOutResolve
    \/ CommitLease \/ PlayResolve
    \/ EngineEnded \/ EngineStarted \/ (\E q \in Items \cup {9} : EnginePromoted(q))
    \/ TimerFire \/ PrefetchResolve

FairActions ==
    /\ WF_vars(BeginStart)
    /\ WF_vars(PrepareResolve)
    /\ WF_vars(FailSettle)
    /\ WF_vars(StopOutResolve)
    /\ WF_vars(CommitLease)
    /\ WF_vars(PlayResolve)
    /\ WF_vars(TimerFire)
    /\ WF_vars(PrefetchResolve)
    /\ WF_vars(DropStart)

Spec == Init /\ [][Next]_vars /\ FairActions

\* -------------------------------------------------------------------------
\* Properties
\* -------------------------------------------------------------------------

\* At most one route sounds — unless an outgoing-stop failure was reported.
SingleAudible ==
    Cardinality({r \in Routes : sounding[r]}) <= 1 \/ stopFailed

\* Incoming play is attempted only after outgoing teardown was attempted.
StopBeforePlay ==
    si.phase \in {"commit", "play"} => (si.outgoing = "none" \/ si.stoppedOut)

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

\* An ended-driven advance may adopt a promotion but must never issue a
\* real play over a lease minted after it was queued.
NoStaleAdvance == ~staleStomp

\* A start that was adopt-eligible (the engine is already playing this
\* item under the live lease) must take the adopt branch — a real play
\* would restart the sounding track. (gapless-promotion regression class)
AdoptedWhenEligible == ~adoptMissed

\* While playing with no handoff in flight, the lease names the current
\* item — unless the engine promoted a foreign queueId (deliberate warn
\* path). Mid-startItem a started for the still-live old lease can set
\* status=playing while currentIndex already moved; that flicker is
\* transient and deliberate, so the check is scoped to settled states.
PlayingLeaseSound ==
    (status = "playing" /\ si.phase = "idle") =>
        (lease.qid = currentIndex \/ foreignPromo)

\* LIVENESS: a started handoff always settles — unless the exploration
\* bound truncated the behavior (bounded checking: a counterexample that
\* only fails at stepCount = MaxSteps says nothing about the code).
StartCompletes ==
    si.phase /= "idle" ~> (si.phase = "idle" \/ stepCount = MaxSteps)

\* LIVENESS: every ended-obligated advance resolves (adopt, play, drop).
AdvanceTerminates == advanceDue ~> (~advanceDue \/ stepCount = MaxSteps)
====
