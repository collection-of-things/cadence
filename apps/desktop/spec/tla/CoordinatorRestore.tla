---- MODULE CoordinatorRestore ----
(***************************************************************************)
(* Models startup restore and engine-restart restore in                    *)
(* apps/desktop/src/coordinator/coordinator.ts and persisted-state.ts.     *)
(*                                                                         *)
(* Two promises:                                                           *)
(*                                                                         *)
(* 1. parsePersistedPlayback must only accept a queue the coordinator can  *)
(*    safely restore. The buggy isQueueState checks only that items have   *)
(*    a string queueId and an object track — no currentIndex bounds, no    *)
(*    track shape — so corrupt settings pass and fail later. CheckStrict   *)
(*    chooses which predicate the model uses.                              *)
(*                                                                         *)
(* 2. notifyEngineRestarted restores queue intent WITHOUT autoplay: the    *)
(*    item is re-loaded paused at the remembered position; nothing is      *)
(*    played until the user commands it.                                   *)
(*                                                                         *)
(* Properties:                                                             *)
(*  - RestoredSound (safety): a restored queue is well-formed — index in   *)
(*    bounds and every item has a usable track.                            *)
(*  - NoAutoplay (safety): after a restart restore, playing only starts    *)
(*    through an explicit user command.                                    *)
(*  - IntentKept (safety): restart keeps the queue and position.           *)
(***************************************************************************)
EXTENDS Integers, Sequences, TLC

CONSTANTS CheckStrict

\* A persisted item either carries a usable track or a corrupt one
\* (missing fields — passes the shallow "track is an object" check only).
GoodItem == [queueId |-> "q1", track |-> "good"]
BadItem  == [queueId |-> "q2", track |-> "bad"]

\* The bounded space of persisted queues the settings file could contain:
\* up to two items (either good or bad) and a currentIndex that may be
\* out of bounds (-1..3 over <= 2 items).
PersistedQueues ==
    { [items |-> s, currentIndex |-> i] :
        s \in {<<>>, <<GoodItem>>, <<BadItem>>, <<GoodItem, GoodItem>>,
                   <<GoodItem, BadItem>>, <<BadItem, GoodItem>>},
        i \in -1..3 }

\* The buggy predicate: items is an array of objects with a string queueId
\* and an object track. Every candidate above satisfies it.
ShallowOk(q) == TRUE

\* The strict predicate: shallow checks PLUS currentIndex in bounds and a
\* usable track on every item.
StrictOk(q) ==
    /\ q.currentIndex >= -1
    /\ q.currentIndex <= Len(q.items) - 1
    /\ (Len(q.items) = 0 => q.currentIndex = -1)
    /\ \A i \in DOMAIN q.items : q.items[i].track = "good"

Accepted(q) == IF CheckStrict THEN StrictOk(q) ELSE ShallowOk(q)

WellFormed(q) ==
    /\ q.currentIndex >= -1 /\ q.currentIndex <= Len(q.items) - 1
    /\ (Len(q.items) = 0 => q.currentIndex = -1)
    /\ \A i \in DOMAIN q.items : q.items[i].track = "good"

VARIABLES
    stored,      \* the persisted queue read from settings
    restored,    \* startup restore has run
    queue,       \* coordinator's live queue (empty record until restored)
    status,      \* "stopped" | "paused" | "playing"
    position,    \* remembered position in ms
    playsIssued, \* adapter.play calls made since construction
    userPlayed,  \* a user command has started playback
    engineUp,    \* shared audio engine alive
    restarted    \* a restart restore has completed

vars == <<stored, restored, queue, status, position, playsIssued,
          userPlayed, engineUp, restarted>>

Init ==
    /\ stored \in PersistedQueues
    /\ restored = FALSE
    /\ queue = [items |-> <<>>, currentIndex |-> -1]
    /\ status = "stopped"
    /\ position = 0
    /\ playsIssued = 0
    /\ userPlayed = FALSE
    /\ engineUp = TRUE
    /\ restarted = FALSE

HasQueue == restored /\ Len(queue.items) > 0

\* Constructor: parsePersistedPlayback gates whether anything restores.
\* Restored intent is PAUSED, never playing (no autoplay on launch). A queue
\* whose index selects nothing (-1: "Play next" additions never played)
\* restores STOPPED with its items — the same shape the code produces.
Restore ==
    /\ ~restored
    /\ restored' = TRUE
    /\ IF Accepted(stored)
         THEN /\ queue' = stored
              /\ status' = IF stored.currentIndex = -1 THEN "stopped" ELSE "paused"
              /\ position' = 12000  \* any remembered position
         ELSE /\ UNCHANGED queue
              /\ status' = "stopped"
              /\ position' = 0
    /\ UNCHANGED <<stored, playsIssued, userPlayed, engineUp, restarted>>

\* The shared engine dies while a queue is loaded.
EngineDies ==
    /\ restored /\ engineUp /\ HasQueue /\ status \in {"playing", "paused"}
    /\ engineUp' = FALSE
    /\ UNCHANGED <<stored, restored, queue, status, position,
                   playsIssued, userPlayed, restarted>>

\* notifyEngineRestarted -> restoreAfterRestart: intent restored paused at
\* the remembered position WITHOUT a play call.
EngineRestarted ==
    /\ ~engineUp
    /\ engineUp' = TRUE
    /\ restarted' = TRUE
    /\ status' = "paused"
    \* each restart needs a fresh explicit command before playing
    /\ userPlayed' = FALSE
    /\ UNCHANGED <<stored, restored, queue, position, playsIssued>>

\* Explicit user commands drive all playback after restore. A stopped queue
\* that still holds items (idle index, or stopped mid-queue) starts too —
\* the code's play command falls back to the top of the play order.
UserPlay ==
    /\ status \in {"paused", "stopped"} /\ HasQueue
    /\ playsIssued < 2  \* bound: replay cycles add nothing new
    /\ playsIssued' = playsIssued + 1
    /\ userPlayed' = TRUE
    /\ status' = "playing"
    /\ UNCHANGED <<stored, restored, queue, position, engineUp, restarted>>

UserPause ==
    /\ status = "playing"
    /\ status' = "paused"
    /\ UNCHANGED <<stored, restored, queue, position, playsIssued,
                   userPlayed, engineUp, restarted>>

\* Terminal: restored and either nothing can ever play or the restart arc
\* has completed.
Done ==
    /\ restored
    /\ (restarted \/ ~HasQueue)
    /\ UNCHANGED vars

Next == Restore \/ EngineDies \/ EngineRestarted \/ UserPlay \/ UserPause
        \/ Done

Spec == Init /\ [][Next]_vars

\* SAFETY: whatever was restored is a queue the coordinator can safely use.
RestoredSound == restored => WellFormed(queue)

\* SAFETY: after a restart restore, "playing" is only reachable through an
\* explicit user command — the restore itself never autoplays.
NoAutoplay == restarted => (status /= "playing" \/ userPlayed)

\* SAFETY: restart restore preserves queue intent and position.
IntentKept == restarted => (HasQueue /\ position = 12000)
====
