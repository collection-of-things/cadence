// restart-oracle.mjs — the restart flow's restore contract as a pure
// function so the harness can regression-test the oracle itself.
//
// What "session restored" must mean (all required):
//   - the persisted settings file records a meaningful position (a real
//     mid-track point — never 0 or ~0, which would mean nothing persisted)
//   - the relaunched queue is the SAME queue: identical ordered track
//     identities AND the same currentIndex (length-only comparison can
//     pass on a different queue; title-only can pass on duplicates)
//   - the restored current track is the same track identity as at quit
//   - status comes back PAUSED — never autoplay
//   - restored position is nonzero and within bounded drift of the
//     persisted position (not merely "not zero" — near where we left)
//   - no stray audio stream while paused

/** Stable identity of a track for restore comparison: the protocol's
 * globally-unique id, falling back to title+album+artists. */
export function trackIdentity(t) {
  if (!t) return null;
  if (t.id) return t.id;
  const artists = (t.artists ?? []).map((a) => a.name ?? a).join(",");
  return `${t.title}|${t.album ?? ""}|${artists}`;
}

export function queueSignature(q) {
  return {
    items: (q?.items ?? []).map((i) => trackIdentity(i.track)),
    currentIndex: q?.currentIndex ?? -1,
  };
}

/**
 * Evaluate the restore contract.
 * @param {object} in
 * @param {object} in.before        snapshot at quit time
 * @param {object} in.qBefore       queue at quit time
 * @param {object} in.restored      snapshot after relaunch
 * @param {object} in.qAfter        queue after relaunch
 * @param {object} in.persisted     parsed cadence-settings.json playback section (or null)
 * @param {number} in.strayStreams  audio stream nodes present while paused
 * @param {object} [in.resumed]     snapshot after resume, or null
 * @param {object} [in.resumedLater] second post-resume snapshot (advancing check)
 * @param {string} in.quitMode      "graceful" | "killed"
 * @returns {Array<[name, ok, detail]>} ordered observations — every one
 *   is a required part of the contract.
 */
export function evaluateRestore({
  before, qBefore, restored, qAfter, persisted, strayStreams, quitMode,
  resumed = null, resumedLater = null,
}) {
  const obs = [];

  const beforePos = before?.positionMs ?? 0;
  obs.push(["position was meaningfully mid-track at quit",
    beforePos >= 2000,
    `quit@${beforePos}ms (>= 2000ms expected — a near-zero quit position makes the whole restore check meaningless)`]);

  const persistedPos = persisted?.positionMs ?? null;
  obs.push(["persisted position is meaningful",
    persistedPos !== null && persistedPos >= 1000,
    `persisted=${persistedPos}ms${persistedPos === null ? " — no playback section in settings file" : ""}`]);

  // the persisted position must agree with the live snapshot at quit —
  // otherwise stale nonzero state could "restore" to itself and pass
  obs.push(["persisted position matches quit snapshot",
    persistedPos !== null && Math.abs(persistedPos - beforePos) < 2500,
    `persisted=${persistedPos}ms vs quit@${beforePos}ms (within 2500ms expected)`]);

  const qB = queueSignature(qBefore);
  const qA = queueSignature(qAfter);
  const sameItems = qB.items.length > 0
    && qB.items.length === qA.items.length
    && qB.items.every((id, i) => id === qA.items[i]);
  obs.push(["queue restored (ordered track identities)",
    sameItems,
    `${qB.items.length} items -> ${qA.items.length}${sameItems ? "" : ` [${qB.items.join("|")}] -> [${qA.items.join("|")}]`}`]);

  obs.push(["queue currentIndex restored",
    qA.currentIndex === qB.currentIndex && qA.currentIndex >= 0,
    `${qB.currentIndex} -> ${qA.currentIndex}`]);

  const tBefore = trackIdentity(before?.current?.track);
  const tAfter = trackIdentity(restored?.current?.track);
  obs.push(["same track restored",
    tBefore !== null && tBefore === tAfter,
    `${before?.current?.track?.title} -> ${restored?.current?.track?.title}`]);

  obs.push(["comes back PAUSED (no autoplay)",
    restored?.status === "paused",
    `status=${restored?.status}`]);

  const restoredPos = restored?.positionMs ?? 0;
  const refPos = persistedPos ?? beforePos;
  obs.push(["position restored within bounded drift",
    restoredPos > 0 && Math.abs(restoredPos - refPos) < 2000,
    `restored@${restoredPos}ms vs ${persistedPos !== null ? "persisted" : "quit"}@${refPos}ms (must be >0 and within 2000ms)`]);

  obs.push(["no audio stream while paused",
    (strayStreams ?? 0) === 0,
    `${strayStreams} stream node(s)`]);

  obs.push(["graceful quit",
    quitMode === "graceful",
    `mode=${quitMode} (a killed quit may persist stale/raced state)`]);

  if (resumed !== null) {
    const tResumed = trackIdentity(resumed?.current?.track);
    obs.push(["resume plays the restored track",
      tResumed !== null && tResumed === tAfter,
      `resumed ${resumed?.current?.track?.title} (expected ${restored?.current?.track?.title})`]);
    obs.push(["resume position advances",
      resumed?.status === "playing"
        && resumedLater !== null
        && (resumedLater.positionMs ?? 0) > (resumed.positionMs ?? 0) + 300,
      `${resumed?.positionMs}ms -> ${resumedLater?.positionMs}ms`]);
  } else {
    // a restore that can't be resumed is not a restore — the absence of a
    // playing snapshot is itself a failed observation, never an omission
    obs.push(["resume after restore works",
      false,
      "neither transport Play nor bridge resume reached playing — no resume evidence"]);
  }

  return obs;
}
