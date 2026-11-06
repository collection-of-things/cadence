#!/usr/bin/env node
/**
 * TLA+ model-check runner for the coordinator specs (spec/tla/).
 *
 *   node scripts/check-specs.mjs            — passing configs must be clean
 *   node scripts/check-specs.mjs --mutants  — also run mutation checks
 *
 * tla-ts always exits 0, so results are parsed from stdout: a run is clean
 * iff it prints "No error" and no "Error" lines. Mutant runs must fail —
 * a mutant that passes proves the property or the mutation is dead.
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
 * Each entry rewrites the fixed code shape back to the buggy one.
 */
const TEXT_MUTANTS = {
  CoordinatorHandoff: [
    {
      name: "no-resilence",
      find: `ELSE [r \\in Routes |-> FALSE]  \\* re-stop covers resurrection`,
      replace: `ELSE sounding  \\* MUTANT: outgoing resurrection ignored`,
      expect: "SingleAudible",
    },
    {
      name: "stale-play-resolve",
      find: `IF lease.g = si.cand`,
      replace: `IF TRUE  \\* MUTANT: stale resolve still commits`,
      expect: "PlayingLeaseSound",
    },
    {
      name: "no-lease-release",
      find: `          /\\ lease' = NoLease
          /\\ active' = "none"`,
      replace: `          /\\ UNCHANGED lease
          /\\ UNCHANGED active`,
      expect: "PlayingLeaseSound",
    },
    {
      name: "no-index-reassert",
      find: `    /\\ currentIndex' = si.idx
    /\\ sounding' = IF si.outgoing`,
      replace: `    /\\ UNCHANGED currentIndex
    /\\ sounding' = IF si.outgoing`,
      expect: "PlayingLeaseSound",
    },
    {
      name: "previdx-rollback",
      find: `currentIndex' = IF lease.qid \\in Items THEN lease.qid ELSE si.prevIdx`,
      replace: `currentIndex' = si.prevIdx`,
      expect: "PrepareFailRollback",
    },
    {
      name: "skip-adopt",
      find: `             ELSE IF /\\ req.adopt`,
      replace: `             ELSE IF /\\ FALSE /\\ req.adopt  \\* MUTANT`,
      expect: "AdoptedWhenEligible",
    },
    {
      name: "skip-outgoing-stop",
      find: `!.phase = IF out = "none" THEN "commit" ELSE "stopout"`,
      replace: `!.phase = "commit"  \\* MUTANT: outgoing stop skipped`,
      expect: "StopBeforePlay",
    },
  ],
  CoordinatorRestore: [
    {
      name: "restore-autoplays",
      find: `status' = "paused"`,
      replace: `status' = "playing"  \\* MUTANT: restore autoplays`,
      expect: "NoAutoplay",
    },
  ],
};

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
    const err = out.match(/^Error: (.*)$/m);
    return { ok: false, error: err?.[1] ?? "unknown" };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const err = out.match(/^Error: (.*)$/m);
    return { ok: false, error: err?.[1] ?? e.message };
  }
}

const cfgs = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".cfg"));
const pass = [], fail = [];

for (const cfg of cfgs.sort()) {
  const isMutant = cfg.includes(".mutant-");
  if (isMutant && !mutants) continue;
  const tla = cfg.replace(/\.mutant-[^.]+/, "").replace(/\.cfg$/, "") + ".tla";
  const r = runCheck(join(SPEC_DIR, tla), join(SPEC_DIR, cfg));
  const want = isMutant ? "fail" : "pass";
  const good = isMutant ? !r.ok : r.ok;
  (good ? pass : fail).push(
    `${cfg.padEnd(48)} ${want === "pass" ? "clean" : `rejected (${r.error})`}${good ? "" : "  UNEXPECTED"}`,
  );
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
      (r.ok ? fail : pass).push(
        `${spec} mutant ${m.name}: ${r.ok ? "checker still passed  UNEXPECTED" : `rejected (${r.error})`}`,
      );
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

for (const line of pass) console.log(`PASS ${line}`);
for (const line of fail) console.log(`FAIL ${line}`);
console.log(`\n${pass.length} checks passed, ${fail.length} unexpected results`);
process.exit(fail.length === 0 ? 0 : 1);
