#!/usr/bin/env node
// cadence-verify — the verify-cadence skill's driver CLI.
//
//   cadence-verify doctor                      environment + build + private-core report
//   cadence-verify run <flow[,flow...]>        one-shot: launch -> flows -> evidence -> teardown
//       [--flavor dev|packaged] [--user-data DIR] [--keep] [--slug NAME] [--break NAME]
//   cadence-verify launch [--flavor ...]       interactive: leave app running, print session dir
//       [--cdp PORT] [--user-data DIR]
//   cadence-verify attach <flow[,...]>         run flows against a `launch`ed session (uses run dir)
//   cadence-verify snap                        print snapshot+queue JSON (attach)
//   cadence-verify shot <name>                 screenshot into run dir (attach)
//   cadence-verify eval <js>                   evaluate in the page (attach)
//   cadence-verify stop                        teardown the recorded session
//   cadence-verify tracks                      print fixture paths
//   cadence-verify selftest                    harness regression tests (node --test helpers/test)
//
// Run dir: verify-runs/<ts>-<slug>/ (latest symlinked at verify-runs/latest).
// Every command exits non-zero on failure. `run` and `attach` always write
// SUMMARY.md + verdict.json — including launch crashes, unknown flows and
// interrupted runs. A PASS requires every required check to have passed.
import { existsSync, symlinkSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { newRunDir, fixtureTracks, readJson, RUNS_ROOT, HELPERS } from "./lib/env.mjs";
import { Evidence, AssertionError } from "./lib/evidence.mjs";
import { doctor, printDoctor } from "./lib/doctor.mjs";
import {
  launchManaged, launchInteractive, teardownRaw, teardownRecorded,
  teardownActiveLaunches, attach, sessionFile,
} from "./lib/session.mjs";
import * as api from "./lib/api.mjs";

const FLOWS = {
  smoke: () => import("./flows/smoke.mjs"),
  navigate: () => import("./flows/navigate.mjs"),
  playback: () => import("./flows/playback.mjs"),
  audio: () => import("./flows/audio.mjs"),
  restart: () => import("./flows/restart.mjs"),
  library: () => import("./flows/library.mjs"),
  providers: () => import("./flows/providers.mjs"),
};

// Deliberate breakage hooks for negative controls — each is implemented
// inside the private session and must turn the run FAIL.
const BREAKS = new Set(["mute", "no-restore"]);

function args() {
  const argv = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      flags[k] = v;
    } else pos.push(argv[i]);
  }
  return { cmd: pos[0] ?? "help", rest: pos.slice(1), flags };
}

function parseBreaks(flag) {
  const names = String(flag ?? "").split(",").filter(Boolean);
  for (const n of names) {
    if (!BREAKS.has(n)) die(`unknown --break "${n}" — known: ${[...BREAKS].join(", ")}`);
  }
  return new Set(names);
}

function findRunDir(flags) {
  if (flags["run-dir"]) return flags["run-dir"];
  const latest = join(RUNS_ROOT, "latest");
  if (existsSync(latest)) return readJson(join(latest, "session.json"))?.runDir ?? latest;
  // otherwise the newest session.json under verify-runs
  if (existsSync(RUNS_ROOT)) {
    const dirs = readdirSync(RUNS_ROOT).filter((d) => d !== "latest").sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
      if (existsSync(join(RUNS_ROOT, dirs[i], "session.json"))) return join(RUNS_ROOT, dirs[i]);
    }
  }
  return latest;
}

/** Run one flow, recording failure honestly: assertion failures already
 * registered their check; anything else is a crash check. */
async function runFlow(ctx, n) {
  ctx.ev.step("flow", `start ${n}`);
  try {
    const mod = await FLOWS[n]();
    await mod.run(ctx);
    ctx.ev.step("flow", `done ${n}`);
    return 0;
  } catch (e) {
    const msg = e instanceof AssertionError ? e.message : `${e.name}: ${e.message}`;
    ctx.ev.step("flow", `FAILED ${n} — ${msg}`);
    if (!(e instanceof AssertionError)) ctx.ev.fail(`flow ${n} crashed`, msg);
    try { await ctx.page.screenshot({ path: ctx.ev.shotName(`fail-${n}`) }); } catch {}
    return 1;
  }
}

async function main() {
  const { cmd, rest, flags } = args();
  const flavor = flags.flavor ?? "dev";

  switch (cmd) {
    case "doctor": {
      const checks = await doctor({ flavor });
      const pass = printDoctor(checks);
      process.exit(pass ? 0 : 1);
    }

    case "tracks": {
      for (const t of fixtureTracks()) console.log(t);
      break;
    }

    case "selftest": {
      const testDir = join(HELPERS, "test");
      const files = existsSync(testDir)
        ? readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).map((f) => join(testDir, f))
        : [];
      if (!files.length) die("no tests under helpers/test");
      // test subprocesses get a PRIVATE tmp under the evidence root — no
      // dependence on (or footprint in) the shared /tmp quota
      const tmp = join(RUNS_ROOT, ".selftest-tmp");
      mkdirSync(tmp, { recursive: true });
      const r = spawnSync(process.execPath, ["--test", ...files], {
        stdio: "inherit",
        env: { ...process.env, TMPDIR: tmp },
      });
      process.exit(r.status ?? 1);
    }

    case "run": {
      const slug = flags.slug ?? (String(rest[0] ?? "smoke").split(",").filter(Boolean).join("-") || "run");
      const runDir = newRunDir(slug);
      linkLatest(runDir);
      const ev = new Evidence(runDir);
      const names = String(rest[0] ?? "smoke").split(",").filter(Boolean);
      const breaks = parseBreaks(flags.break);
      let ctx = null;
      let failures = 0;
      let interrupted = false;
      let signalDone = null;
      // CI kills: SIGTERM/SIGINT must still tear down and write a verdict.
      // The normal flow below races the abort: if the in-flight launch
      // rejects fast, this body could exit(1) BEFORE teardown finished —
      // losing both the signal code and the last kills. The main path
      // therefore waits on signalDone instead of exiting on its own.
      const onSignal = (sig) => {
        if (interrupted) return;
        interrupted = true;
        signalDone = (async () => {
          try {
            ev.fail("run interrupted", `received ${sig} — teardown running`);
            // reap in-flight launch resources FIRST (ctx may not exist yet),
            // then the finished session if there is one
            try { await teardownActiveLaunches(); } catch {}
            try { if (ctx) await teardownRaw(ctx); } catch {}
            try { ev.summary({ flows: names, flavor, interrupted: sig }); } catch {}
          } finally {
            process.exit(sig === "SIGINT" ? 130 : 143);
          }
        })();
      };
      const sigint = () => onSignal("SIGINT");
      const sigterm = () => onSignal("SIGTERM");
      process.on("SIGINT", sigint);
      process.on("SIGTERM", sigterm);
      try {
        // unknown or empty flow sets are failures WITH evidence, not usage
        // errors that vanish into stderr
        if (!names.length) ev.fail("flow selection", "no flows selected (run <flow>[,<flow>])");
        for (const n of names) {
          if (!FLOWS[n]) ev.fail("flow selection", `unknown flow "${n}" — known: ${Object.keys(FLOWS).join(", ")}`);
        }
        if (flags.pw && flags.pw !== "private") {
          // session mode is gone: it mutated the user's real audio session
          ev.fail("pw mode", `--pw ${flags.pw} is not supported — only a private PipeWire core is allowed`);
        }
        if (flags.keep) {
          // managed launches are not reliably persistable past this
          // process's exit (playwright reaps its child); `launch` is the
          // honest persistent path
          ev.fail("flag --keep", "not supported for `run` — use `launch` + `attach`/`stop` for a persistent session");
        }
        const invalid = names.length === 0 || names.some((n) => !FLOWS[n])
          || (flags.pw && flags.pw !== "private") || !!flags.keep;
        if (!invalid) {
          ctx = await launchManaged({ flavor, userData: flags["user-data"], runDir });
          ctx.ev = ev;
          ctx.breaks = breaks;
          ev.check("app launches and bridge ready", true, `flavor=${flavor}`);
          for (const n of names) failures += await runFlow(ctx, n);
        }
      } catch (e) {
        failures++;
        // ev.fail (not ev.check): a throw here must not escape before the
        // summary is written — the FAIL verdict is the deliverable
        ev.fail("launch", `${e.name}: ${e.message}`);
      } finally {
        try { await ctx?.page?.screenshot({ path: ev.shotName("teardown-state") }); } catch {}
        if (ctx) {
          try { await teardownRaw(ctx); } catch (e) { ev.step("teardown", `error: ${e.message}`); }
        }
        ev.dumpState("session", ctx?.meta ?? {});
      }
      // a signal during launch/flows owns the exit: its teardown decides
      // the code and writes the interrupted summary. Wait for it rather
      // than racing an exit(1) through incomplete cleanup.
      if (interrupted) { try { await signalDone; } catch {} return; }
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
      let verdict = "FAIL";
      try { verdict = ev.summary({ flows: names, flavor }); }
      catch (e) { console.error(`summary failed: ${e.message}`); }
      console.log(`\n${verdict === "PASS" ? "VERIFY: PASS" : "VERIFY: FAIL"}  evidence: ${runDir}`);
      process.exit(verdict === "PASS" && failures === 0 ? 0 : 1);
    }

    case "launch": {
      const runDir = newRunDir(flags.slug ?? "interactive");
      linkLatest(runDir);
      // a signal during bringup must still reap the detached resources
      // already acquired (Xvfb, private core, profile) — same as `run`.
      // Same exit race as `run`: the aborted launch's catch path could
      // die(1) before teardown completes — yield the exit to the handler.
      let interrupted = false;
      let signalDone = null;
      const onSignal = (sig) => {
        if (interrupted) return;
        interrupted = true;
        signalDone = (async () => {
          try {
            try { await teardownActiveLaunches(); } catch {}
            const ev = new Evidence(runDir);
            ev.fail("launch interrupted", `received ${sig}`);
            try { ev.summary({ launch: true, flavor, interrupted: sig }); } catch {}
          } finally {
            process.exit(sig === "SIGINT" ? 130 : 143);
          }
        })();
      };
      const sigint = () => onSignal("SIGINT");
      const sigterm = () => onSignal("SIGTERM");
      process.on("SIGINT", sigint);
      process.on("SIGTERM", sigterm);
      try {
        if (flags.pw && flags.pw !== "private") {
          throw new Error(`--pw ${flags.pw} is not supported — only a private PipeWire core is allowed`);
        }
        const ctx = await launchInteractive({
          flavor, userData: flags["user-data"], runDir,
          cdpPort: flags.cdp ? Number(flags.cdp) : null,
        });
        if (interrupted) { try { await signalDone; } catch {} return; }
        process.off("SIGINT", sigint);
        process.off("SIGTERM", sigterm);
        console.log(`launched pid=${ctx.meta.pid} display=${ctx.xvfb.display} cdp=${ctx.meta.cdpPort}`);
        console.log(`session: ${sessionFile(runDir)}`);
        console.log(`attach:   cadence-verify attach <flow> --run-dir ${runDir}`);
        console.log(`          cadence-verify snap | shot <name> | eval <js> --run-dir ${runDir}`);
        console.log(`stop:     cadence-verify stop --run-dir ${runDir}`);
        // leave running on purpose
      } catch (e) {
        // if a signal is mid-teardown, it owns the exit — don't die(1)
        // through incomplete cleanup
        if (interrupted) { try { await signalDone; } catch {} return; }
        // a failed interactive launch still leaves a durable FAIL verdict
        const ev = new Evidence(runDir);
        ev.fail("launch", `${e.name}: ${e.message}`);
        ev.summary({ launch: true, flavor });
        console.error(`cadence-verify: launch failed — ${e.message}`);
        process.exit(1);
      }
      break;
    }

    case "attach": {
      const names = (rest[0] ?? "").split(",").filter(Boolean);
      const runDir = findRunDir(flags);
      const ev = new Evidence(runDir);
      ev.step("attach", `attaching flows [${names.join(", ")}] to ${runDir}`);
      if (!names.length) ev.fail("flow selection", "attach needs at least one flow");
      const unknown = names.filter((n) => !FLOWS[n]);
      for (const n of unknown) ev.fail("flow selection", `unknown flow "${n}"`);
      if (!names.length || unknown.length) {
        const verdict = ev.summary({ flows: names, attached: true });
        console.log(`\n${verdict}  evidence: ${runDir}`);
        process.exit(1);
      }
      let attached;
      try {
        attached = await attach(runDir);
      } catch (e) {
        // stale/foreign endpoint or dead session — a FAIL verdict, not a
        // silent exit. Prior checks in this run dir are already merged in.
        ev.fail("attach", `${e.name}: ${e.message}`);
        const verdict = ev.summary({ flows: names, attached: true });
        console.log(`\n${verdict}  evidence: ${runDir}`);
        process.exit(1);
      }
      const { meta, browser, page, pw } = attached;
      const ctx = { meta, browser, page, pw, ev, flavor: meta.flavor, ud: meta.userData, runDir };
      let fails = 0;
      for (const n of names) fails += await runFlow(ctx, n);
      const verdict = ev.summary({ flows: names, attached: true });
      console.log(`\n${verdict}  evidence: ${runDir}`);
      await browser.close();
      process.exit(verdict === "PASS" && fails === 0 ? 0 : 1);
    }

    case "snap": {
      const { browser, page } = await attach(findRunDir(flags));
      console.log(JSON.stringify({ snapshot: await api.snapshot(page), queue: await api.queue(page) }, null, 2));
      await browser.close();
      break;
    }

    case "shot": {
      const runDir = findRunDir(flags);
      const { browser, page } = await attach(runDir);
      const p = join(runDir, "evidence", `${rest[0] ?? "shot"}.png`);
      await page.screenshot({ path: p });
      console.log(p);
      await browser.close();
      break;
    }

    case "eval": {
      const { browser, page } = await attach(findRunDir(flags));
      const r = await page.evaluate(async (src) => {
        const v = eval(src);
        return v instanceof Promise ? await v : v;
      }, rest.join(" "));
      console.log(JSON.stringify(r, null, 2));
      await browser.close();
      break;
    }

    case "stop":
    case "cleanup": {
      const runDir = findRunDir(flags);
      const meta = await teardownRecorded(runDir);
      console.log(`stopped pid=${meta.pid}; evidence kept in ${meta.runDir}`);
      for (const n of meta.teardownNotes ?? []) console.log(`  ${n}`);
      break;
    }

    default:
      console.log(`unknown command "${cmd}"\n`);
      console.log("commands: doctor | run | launch | attach | snap | shot | eval | stop | tracks | selftest");
      process.exit(2);
  }
}

function linkLatest(runDir) {
  const l = join(RUNS_ROOT, "latest");
  try { rmSync(l, { recursive: true, force: true }); } catch {}
  try { symlinkSync(runDir, l, "dir"); } catch {}
}

function die(msg) {
  console.error(`cadence-verify: ${msg}`);
  process.exit(2);
}

main().catch((e) => { console.error(`cadence-verify: ${e.stack ?? e}`); process.exit(1); });
