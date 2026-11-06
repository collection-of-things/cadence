#!/usr/bin/env node
/**
 * TLA+ model-check runner for the coordinator specs (spec/tla/).
 *
 *   node scripts/check-specs.mjs            — passing configs must be clean
 *   node scripts/check-specs.mjs --mutants  — mutation checks only
 *
 * tla-ts always exits 0, so results are parsed from stdout: a run is clean
 * iff it prints "No error" and no "Error" lines. A mutant must be rejected
 * by its DECLARED property — a parse error, crash, or a different invariant
 * firing does not count (a mutant that can't reach its property is dead).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "tla");
const TLA_TS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  ".bin",
  "tla-ts",
);
const mutants = process.argv.includes("--mutants");

/**
 * Text mutations: a broken guard in the spec must make the checker fail.
 * Each entry rewrites the fixed code shape back to the buggy one, and
 * `expects` lists the properties whose failure proves the mutation alive.
 */
const TEXT_MUTANTS = {
  CoordinatorHandoff: [
    {
      name: "no-resilence",
      find: `!.phase = IF si.outgoing = "none" THEN "play" ELSE "resile"`,
      replace: `!.phase = "play"`,
      expects: ["SingleAudible"],
    },
    {
      name: "stale-play-resolve",
      find: `IF lease.g = si.cand`,
      replace: `IF TRUE  \\* MUTANT: stale resolve still commits`,
      expects: ["PlayingLeaseSound"],
    },
    {
      name: "no-lease-release",
      find: `          /\\ lease' = NoLease
          /\\ active' = "none"`,
      replace: `          /\\ UNCHANGED lease
          /\\ UNCHANGED active`,
      expects: ["SingleAudible", "PlayingLeaseSound", "PlayingMeansSounding"],
    },
    {
      name: "no-index-reassert",
      find: `    /\\ currentIndex' = si.idx`,
      replace: `    /\\ UNCHANGED currentIndex`,
      expects: ["PlayingLeaseSound"],
    },
    {
      name: "previdx-rollback",
      find: `currentIndex' = IF lease.qid \\in Items THEN lease.qid ELSE si.prevIdx`,
      replace: `currentIndex' = si.prevIdx`,
      expects: ["PrepareFailRollback"],
    },
    // The old "adopt a promoted track" branch was removed when staleness
    // became (generation, queueId): every promotion moves the lease's
    // queueId, so an adopt-eligible link is always stale-skipped first.
    // That protection is now NoMovedAdvance / gen-only-staleness.
    {
      name: "skip-outgoing-stop",
      find: `!.phase = IF out = "none" THEN "commit" ELSE "stopout"`,
      replace: `!.phase = IF out = "none" THEN "commit" ELSE "commit"`,
      expects: ["StopBeforePlay"],
    },
    {
      name: "baked-advance-target",
      find: `target == IF req.endedQid /= 0 THEN Succ[req.endedQid] ELSE req.idx`,
      replace: `target == req.idx  \\* MUTANT: index baked at event time`,
      expects: ["PlayingMeansSounding", "AdvanceTargetSound", "NoStaleAdvance"],
    },
    {
      name: "gen-only-staleness",
      find: `(req.gen /= lease.g \\/ req.endedQid /= lease.qid)`,
      replace: `req.gen /= lease.g  \\* MUTANT: item identity unchecked`,
      expects: ["NoMovedAdvance"],
    },
    {
      name: "skip-clears-promotion",
      find: `                         /\\ UNCHANGED <<generation, lease, status, currentIndex,
                                        active, sounding, pendingPrefetch,
                                        armedGen, armedQid, inFlight,`,
      replace: `                         /\\ armedGen' = 0
                         /\\ armedQid' = 0  \\* MUTANT: skip kills promotion window
                         /\\ UNCHANGED <<generation, lease, status, currentIndex,
                                        active, sounding, pendingPrefetch,
                                        inFlight,`,
      expects: ["PlayingMeansSounding", "AdvanceTerminates"],
    },
  ],
  CoordinatorRestore: [
    {
      name: "restore-autoplays",
      find: `status' = "paused"`,
      replace: `status' = "playing"  \\* MUTANT: restore autoplays`,
      expects: ["NoAutoplay"],
    },
  ],
};

/** Extract the property the checker blamed, from its output text. */
function blamedProperty(out) {
  const inv = out.match(/^Error: Invariant (\w+) is violated/m);
  if (inv) return inv[1];
  const temp = out.match(/^Error: Temporal property (\w+) was violated/m);
  if (temp) return temp[1];
  if (/^Error: Deadlock reached/m.test(out)) return "Deadlock";
  if (/\*\*\*Parse Error\*\*\*/.test(out) || /Semantic.*[Ee]rror/m.test(out)) return "ParseError";
  const err = out.match(/^Error: (.*)$/m);
  return err?.[1] ?? null;
}

function runCheck(tlaFile, cfgFile) {
  try {
    const out = execFileSync(TLA_TS, [tlaFile, "-config", cfgFile], {
      cwd: SPEC_DIR,
      encoding: "utf8",
      timeout: 900_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.includes("No error")) return { ok: true };
    return { ok: false, blamed: blamedProperty(out) ?? "unknown" };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    return { ok: false, blamed: blamedProperty(out) ?? e.message };
  }
}

/** A mutant cfg declares the properties that may prove it: `\* EXPECTS X Y`. */
function cfgExpects(cfgPath) {
  const m = readFileSync(cfgPath, "utf8").match(/^\s*\\\*\s*EXPECTS\s+([\w| ]+)$/m);
  return m ? m[1].trim().split(/[| ]+/).filter(Boolean) : null;
}

const cfgs = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".cfg"));
const pass = [], fail = [];

for (const cfg of cfgs.sort()) {
  const isMutant = cfg.includes(".mutant-");
  if (isMutant !== mutants) continue; // default: pass cfgs; --mutants: mutants only
  const tla = cfg.replace(/\.mutant-[^.]+/, "").replace(/\.cfg$/, "") + ".tla";
  const r = runCheck(join(SPEC_DIR, tla), join(SPEC_DIR, cfg));
  if (!isMutant) {
    (r.ok ? pass : fail).push(`${cfg.padEnd(48)} clean${r.ok ? "" : `  UNEXPECTED (${r.blamed})`}`);
    continue;
  }
  const expects = cfgExpects(join(SPEC_DIR, cfg));
  // No EXPECTS declaration = the mutant asserts nothing — a rejection is
  // meaningless. Only a declared-property kill counts.
  const good = !r.ok && expects !== null && expects.includes(r.blamed);
  (good ? pass : fail).push(
    `${cfg.padEnd(48)} rejected (${r.blamed ?? "no error reported"})${good ? "" : `  UNEXPECTED, wanted ${expects?.join("|") ?? "an EXPECTS declaration"}`}`,
  );

  // Bounds must match the parent pass cfg — a stale or missing bound here
  // would silently change which traces the mutant covers.
  const parent = readFileSync(join(SPEC_DIR, `${cfg.replace(/\.mutant-[^.]+/, "")}`), "utf8");
  const mutantText = readFileSync(join(SPEC_DIR, cfg), "utf8");
  for (const bound of ["MaxGen", "MaxSteps", "MaxStarts"]) {
    const pv = parent.match(new RegExp(`${bound}\\s*=\\s*(\\d+)`))?.[1];
    const mv = mutantText.match(new RegExp(`${bound}\\s*=\\s*(\\d+)`))?.[1];
    if (pv !== undefined && pv !== mv) {
      fail.push(`${cfg.padEnd(48)} bound drift: ${bound}=${mv ?? "missing"}, parent=${pv}  UNEXPECTED`);
    }
  }
}

if (mutants) {
  for (const [spec, ms] of Object.entries(TEXT_MUTANTS)) {
    const tlaPath = join(SPEC_DIR, `${spec}.tla`);
    const cfgPath = join(SPEC_DIR, `${spec}.cfg`);
    const src = readFileSync(tlaPath, "utf8");
    const tmp = mkdtempSync(join(tmpdir(), "tla-mut-"));
    for (const m of ms) {
      if (!src.includes(m.find)) {
        fail.push(`${spec}.${m.name}: mutation anchor not found  UNEXPECTED`);
        continue;
      }
      const mutated = src.replace(m.find, m.replace);
      const tmpSpec = join(tmp, `${spec}.tla`);
      const tmpCfg = join(tmp, `${spec}.cfg`);
      writeFileSync(tmpSpec, mutated);
      copyFileSync(cfgPath, tmpCfg);
      const r = runCheck(tmpSpec, tmpCfg);
      const good = !r.ok && m.expects.includes(r.blamed);
      const detail = r.ok ? "checker still passed" : `rejected (${r.blamed})`;
      (good ? pass : fail).push(
        `${spec} mutant ${m.name}: ${detail}${good ? "" : `  UNEXPECTED, wanted ${m.expects.join("|")}`}`,
      );
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

for (const line of pass) console.log(`PASS ${line}`);
for (const line of fail) console.log(`FAIL ${line}`);
console.log(`\n${pass.length} checks passed, ${fail.length} unexpected results`);
process.exit(fail.length === 0 ? 0 : 1);
