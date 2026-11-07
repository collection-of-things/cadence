---- MODULE CoordinatorChain ----
(***************************************************************************)
(* Models the serialization promise of `this.chain` in                     *)
(* apps/desktop/src/coordinator/coordinator.ts.                            *)
(*                                                                         *)
(* Every command and event-driven mutation is appended as a link:          *)
(*   next = prev.then(task)                                                *)
(* A GUARDED link stores `next.then(ok, ok)` back into `this.chain`        *)
(* (handleCommand, enqueueStart); an UNGUARDED link stores raw `next`      *)
(* (notifyEngineRestarted and the `ended` advance in the buggy revision).  *)
(*                                                                         *)
(* Semantics this model encodes:                                           *)
(*  - a link's task runs only if this.chain is fulfilled;                  *)
(*  - if this.chain is rejected, the task is SKIPPED (silently, for        *)
(*    internal links; the user command's returned promise rejects);        *)
(*  - a guarded store always leaves this.chain fulfilled;                  *)
(*  - an unguarded store leaves this.chain rejected iff the link's        *)
(*    result rejected (task threw, or task was skipped).                   *)
(*  - a task whose adapter call has no timeout may never settle: the       *)
(*    chain freezes with it as head (wedged).                              *)
(*                                                                         *)
(* Properties:                                                             *)
(*  - NoDropped (safety): no user command's dispatch is ever skipped.      *)
(*  - AllApplied (liveness): every queued command's dispatch eventually    *)
(*    runs and the chain drains.                                           *)
(***************************************************************************)
EXTENDS Integers, Sequences, TLC

CONSTANTS
    MaxUserCmds,      \* bound on user commands enqueued
    MaxInternal,      \* bound on event-driven internal links enqueued
    InternalGuarded,  \* TRUE = fixed code: internal links use the guarded store
                      \* FALSE = buggy code: ended-advance and restart links stored raw
    CallsHaveTimeout  \* TRUE = fixed code: every adapter call in a link is timeout-bound
                      \* FALSE = buggy code: applyEffectiveVolume's setVolume can hang

VARIABLES
    rejected,        \* this.chain currently holds a rejected promise
    links,           \* sequence of pending links [guard |-> BOOLEAN, cmd |-> Nat]
    cmdState,        \* user cmd id -> "none" | "queued" | "ran" | "dropped"
    userEnqueued,    \* user commands appended so far
    intEnqueued,     \* internal links appended so far
    wedged           \* head link's adapter call never settles; chain frozen

vars == <<rejected, links, cmdState, userEnqueued, intEnqueued, wedged>>

UserCmds == 1..MaxUserCmds

Init ==
    /\ rejected = FALSE
    /\ links = <<>>
    /\ cmdState = [c \in UserCmds |-> "none"]
    /\ userEnqueued = 0
    /\ intEnqueued = 0
    /\ wedged = FALSE

\* handleCommand: a user command appends a GUARDED link.
EnqueueUser ==
    /\ userEnqueued < MaxUserCmds
    /\ links' = Append(links, [guard |-> TRUE, cmd |-> userEnqueued + 1])
    /\ cmdState' = [cmdState EXCEPT ![userEnqueued + 1] = "queued"]
    /\ userEnqueued' = userEnqueued + 1
    /\ UNCHANGED <<rejected, intEnqueued, wedged>>

\* Event-driven work (notifyEngineRestarted, ended-advance): appended with
\* whatever guard the code under test uses.
EnqueueInternal ==
    /\ intEnqueued < MaxInternal
    /\ links' = Append(links, [guard |-> InternalGuarded, cmd |-> 0])
    /\ intEnqueued' = intEnqueued + 1
    /\ UNCHANGED <<rejected, cmdState, userEnqueued, wedged>>

\* The head link settles. When the chain is rejected the task never runs;
\* when it runs it may settle ok, throw, or — without a timeout on every
\* adapter call — hang forever.
RunLink ==
    /\ links /= <<>>
    /\ ~wedged
    /\ LET l == Head(links) IN
        IF rejected
        THEN \* task skipped; result stays rejected
            /\ links' = Tail(links)
            /\ cmdState' = IF l.cmd > 0
                             THEN [cmdState EXCEPT ![l.cmd] = "dropped"]
                             ELSE cmdState
            /\ rejected' = ~l.guard   \* guarded rewrap heals the chain
            /\ UNCHANGED wedged
        ELSE \* task runs
            /\ cmdState' = IF l.cmd > 0
                             THEN [cmdState EXCEPT ![l.cmd] = "ran"]
                             ELSE cmdState
            /\ \/ \* settles (ok or throw — both end the link)
                   /\ \E threw \in {TRUE, FALSE} :
                        rejected' = IF threw THEN ~l.guard ELSE FALSE
                   /\ links' = Tail(links)
                   /\ UNCHANGED wedged
               \/ \* adapter call never returns: the link hangs and so does
                   \* everything queued behind it
                   /\ ~CallsHaveTimeout
                   /\ wedged' = TRUE
                   /\ UNCHANGED <<links, rejected>>
    /\ UNCHANGED <<userEnqueued, intEnqueued>>

\* Terminal: everything enqueued has run and the queue is empty. A wedged
\* head link is NOT terminal — it is a frozen chain, which the liveness
\* property reports and which TLC reports as deadlock.
Done ==
    /\ links = <<>>
    /\ ~wedged
    /\ userEnqueued = MaxUserCmds
    /\ intEnqueued = MaxInternal
    /\ UNCHANGED vars

Next == EnqueueUser \/ EnqueueInternal \/ RunLink \/ Done

Spec == Init /\ [][Next]_vars /\ WF_vars(RunLink) /\ WF_vars(EnqueueUser)

\* SAFETY: no user command's dispatch is ever skipped.
NoDropped == \A c \in UserCmds : cmdState[c] /= "dropped"

\* LIVENESS: all commands get enqueued, every dispatch runs, chain drains.
AllApplied ==
    <>( /\ userEnqueued = MaxUserCmds
        /\ \A c \in UserCmds : cmdState[c] = "ran"
        /\ links = <<>> )
====
