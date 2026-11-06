// evidence.mjs — where proof goes. Every run gets a directory:
//   verify-runs/<ts>-<slug>/
//     evidence/transcript.jsonl  — one line per action/assertion
//     evidence/*.png             — screenshots
//     state/*.json               — snapshot/queue/settings/capabilities dumps
//     audio/*.f32le,*.wav        — PipeWire monitor captures
//     logs/*.log                 — electron/audio stderr, pw-dump captures
//     SUMMARY.md                 — verdicts a reviewer can skim
// Teardown never touches this directory.
import { appendFileSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nowIso, writeJson } from "./env.mjs";

export class Evidence {
  constructor(runDir) {
    this.dir = runDir;
    this.transcript = join(runDir, "evidence", "transcript.jsonl");
    this.checks = [];
    this.step("run", `run dir ${runDir}`);
  }

  /** Record an action or observation (not an assertion). */
  step(kind, detail, extra = {}) {
    appendFileSync(this.transcript, JSON.stringify({ t: nowIso(), kind, detail, ...extra }) + "\n");
  }

  /** Record an assertion result; throws when required and failed. */
  check(name, ok, detail = "", { required = true } = {}) {
    const entry = { name, ok: !!ok, detail, required };
    this.checks.push(entry);
    const tag = ok ? "PASS" : required ? "FAIL" : "NOTE";
    this.step("check", `${tag} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok && required) {
      throw new AssertionError(name, detail);
    }
    return ok;
  }

  shotName(name) { return join(this.dir, "evidence", `${name}.png`); }
  statePath(name) { return join(this.dir, "state", `${name}.json`); }
  audioPath(name) { return join(this.dir, "audio", name); }
  logPath(name) { return join(this.dir, "logs", name); }

  dumpState(name, obj) {
    writeJson(this.statePath(name), obj);
    this.step("state", `dumped ${name}`, { path: this.statePath(name) });
  }

  copyIn(src, name) {
    const dst = join(this.dir, "state", name);
    try { cpSync(src, dst); this.step("state", `captured ${name}`, { path: dst }); } catch {}
    return dst;
  }

  summary(extra = {}) {
    const failed = this.checks.filter((c) => !c.ok && c.required);
    const noted = this.checks.filter((c) => !c.ok && !c.required);
    const verdict = failed.length === 0 ? "PASS" : "FAIL";
    const lines = [
      `# verify-cadence run — ${verdict}`,
      "",
      `run dir: ${this.dir}`,
      `checks: ${this.checks.length} (${this.checks.length - failed.length - noted.length} pass, ${failed.length} fail, ${noted.length} noted)`,
      "",
      "## checks",
      ...this.checks.map((c) => `- ${c.ok ? "PASS" : c.required ? "FAIL" : "NOTE"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`),
      "",
      "## artifacts",
      "- evidence/transcript.jsonl — every action + assertion",
      "- evidence/*.png — screenshots",
      "- state/*.json — coordinator snapshot/queue/settings dumps",
      "- audio/*.f32le,*.wav — PipeWire monitor captures",
      "- logs/ — electron + audio-service stderr, pw-dump captures",
    ];
    writeFileSync(join(this.dir, "SUMMARY.md"), lines.join("\n") + "\n");
    writeJson(join(this.dir, "verdict.json"), { verdict, checks: this.checks, ...extra });
    return verdict;
  }
}

export class AssertionError extends Error {
  constructor(name, detail) {
    super(`assertion failed: ${name}${detail ? ` — ${detail}` : ""}`);
    this.name = "AssertionError";
    this.checkName = name;
  }
}
