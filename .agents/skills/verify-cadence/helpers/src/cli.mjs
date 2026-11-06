#!/usr/bin/env node
// cadence-verify — the verify-cadence skill's driver CLI.
//
//   cadence-verify doctor                      environment + build + PipeWire report (read-only)
//   cadence-verify run <flow[,flow...]>        one-shot: launch -> flows -> evidence -> teardown
//       [--flavor dev|packaged] [--user-data DIR] [--keep] [--slug NAME]
//   cadence-verify launch [--flavor ...]       interactive: leave app running, print session dir
//       [--cdp PORT] [--user-data DIR]
//   cadence-verify attach <flow[,...]>         run flows against a `launch`ed session (uses run dir)
//   cadence-verify snap                        print snapshot+queue JSON (attach)
//   cadence-verify shot <name>                 screenshot into run dir (attach)
//   cadence-verify eval <js>                   evaluate in the page (attach)
//   cadence-verify stop                        teardown the recorded session
//   cadence-verify tracks                      print fixture paths
//
// Run dir: verify-runs/<ts>-<slug>/ (latest symlinked at verify-runs/latest).
// Every command exits non-zero on failure. `run` exits non-zero when any
// required check fails; the evidence (incl. the failure) always survives.
import { existsSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newRunDir, fixtureTracks, writeJson, readJson, RUNS_ROOT } from "./lib/env.mjs";
import { Evidence, AssertionError } from "./lib/evidence.mjs";
import { doctor, printDoctor } from "./lib/doctor.mjs";
import {
  launchManaged, launchInteractive, teardownRaw, teardownRecorded, attach, sessionFile,
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

    case "run": {
      const names = (rest[0] ?? "smoke").split(",").filter(Boolean);
      for (const n of names) if (!FLOWS[n]) die(`unknown flow "${n}" — known: ${Object.keys(FLOWS).join(", ")}`);
      const slug = flags.slug ?? names.join("-");
      const runDir = newRunDir(slug);
      linkLatest(runDir);
      const ev = new Evidence(runDir);
      let ctx = null;
      let failures = 0;
      try {
        ctx = await launchManaged({ flavor, userData: flags["user-data"], runDir, pwMode: flags.pw ?? "private" });
        ctx.ev = ev;
        ev.check("app launches and bridge ready", true, `flavor=${flavor}`);
        for (const n of names) {
          ev.step("flow", `start ${n}`);
          try {
            const mod = await FLOWS[n]();
            await mod.run(ctx);
            ev.step("flow", `done ${n}`);
          } catch (e) {
            failures++;
            const msg = e instanceof AssertionError ? e.message : `${e.name}: ${e.message}`;
            ev.step("flow", `FAILED ${n} — ${msg}`);
            // a crash (non-assertion error) is itself a failure — an
            // AssertionError already registered its failing check
            if (!(e instanceof AssertionError)) ev.check(`flow ${n} crashed`, false, msg);
            try { await ctx.page.screenshot({ path: ev.shotName(`fail-${n}`) }); } catch {}
          }
        }
      } catch (e) {
        failures++;
        ev.check("launch", false, e.message);
      } finally {
        try { await ctx?.page?.screenshot({ path: ev.shotName("teardown-state") }); } catch {}
        if (ctx && !flags.keep) await teardownRaw(ctx);
        ev.dumpState("session", ctx?.meta ?? {});
      }
      const verdict = ev.summary({ flows: names, flavor });
      console.log(`\n${verdict === "PASS" ? "VERIFY: PASS" : "VERIFY: FAIL"}  evidence: ${runDir}`);
      process.exit(verdict === "PASS" && failures === 0 ? 0 : 1);
    }

    case "launch": {
      const runDir = newRunDir(flags.slug ?? "interactive");
      linkLatest(runDir);
      const ctx = await launchInteractive({
        flavor, userData: flags["user-data"], runDir,
        cdpPort: Number(flags.cdp ?? 9333), pwMode: flags.pw ?? "private",
      });
      console.log(`launched pid=${ctx.meta.pid} display=${ctx.xvfb.display} cdp=${ctx.meta.cdpPort}`);
      console.log(`session: ${sessionFile(runDir)}`);
      console.log(`attach:   cadence-verify attach <flow> --run-dir ${runDir}`);
      console.log(`          cadence-verify snap | shot <name> | eval <js> --run-dir ${runDir}`);
      console.log(`stop:     cadence-verify stop --run-dir ${runDir}`);
      // leave running on purpose
      break;
    }

    case "attach": {
      const names = (rest[0] ?? "").split(",").filter(Boolean);
      if (!names.length) die("attach needs at least one flow");
      const runDir = findRunDir(flags);
      const { meta, browser, page, pw } = await attach(runDir);
      const ev = new Evidence(runDir);
      const ctx = { meta, browser, page, pw, ev, flavor: meta.flavor, ud: meta.userData, runDir };
      for (const n of names) {
        if (!FLOWS[n]) die(`unknown flow "${n}"`);
        try {
          const mod = await FLOWS[n]();
          await mod.run(ctx);
        } catch (e) {
          ev.step("flow", `FAILED ${n} — ${e.message}`);
        }
      }
      const verdict = ev.summary({ flows: names, attached: true });
      console.log(`\n${verdict}  evidence: ${runDir}`);
      await browser.close();
      process.exit(verdict === "PASS" ? 0 : 1);
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
      break;
    }

    default:
      console.log(`unknown command "${cmd}"\n`);
      console.log("commands: doctor | run | launch | attach | snap | shot | eval | stop | tracks");
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
