#!/usr/bin/env node
// Fresh-clone reproducibility check (PRD FR-11, BUILD_PLAN P8 "done when"): clone this repo's HEAD
// into a temp dir, install from the lockfile, and run `pnpm notary replay` there with NO .env and an
// environment stripped of every credential-looking variable. Reports each step's exit code and
// output. Plain Node, no dependencies.
//
//   node scripts/fresh-clone-check.mjs [--include-uncommitted] [--test] [--keep]
//
//   --include-uncommitted  also apply the working tree's uncommitted changes (tracked diff + untracked,
//                          non-ignored files) on top of HEAD, to check work before it is committed.
//                          Ignored files (.env, runs/, node_modules) are never copied.
//   --test                 also run `pnpm test` in the clone
//   --keep                 keep the temp clone (path is printed)
//
// Exit code: the replay's exit code (0 = reproduced exactly, 3 = BLOCKED: nothing recorded to
// replay, 1 = replay failed); 1 if the clone, install or tests fail.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const includeUncommitted = args.has("--include-uncommitted");
const runTests = args.has("--test");
const keep = args.has("--keep");

// Anything that could carry a credential or point a run at a live service is removed.
const CREDENTIAL_VAR = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION|^AWS_|^NOTARY_|^NEATLOGS|^DODO|^CRUSTDATA|^ANTHROPIC|^OPENAI)/i;
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CREDENTIAL_VAR.test(k)));
const removedVars = Object.keys(process.env).filter((k) => CREDENTIAL_VAR.test(k)).sort();

function run(cmd, cmdArgs, cwd, opts = {}) {
  const started = Date.now();
  // pnpm is a .cmd shim on Windows and needs a shell; its arguments here never contain spaces.
  // git gets no shell, so paths with spaces stay single arguments.
  const shell = process.platform === "win32" && cmd === "pnpm";
  const r = spawnSync(cmd, cmdArgs, { cwd, env: opts.env ?? cleanEnv, encoding: "utf8", shell, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 15 * 60_000 });
  return {
    command: [cmd, ...cmdArgs].join(" "),
    exitCode: r.status ?? (r.error ? -1 : null),
    error: r.error ? String(r.error.message ?? r.error) : undefined,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function git(gitArgs, cwd = root) {
  return run("git", gitArgs, cwd, { env: process.env });
}

function tail(text, n) {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

const report = { repo: root, head: git(["rev-parse", "HEAD"]).stdout.trim(), includeUncommitted, removedCredentialVars: removedVars, steps: [] };
const base = mkdtempSync(join(tmpdir(), "notary-fresh-clone-"));
const clone = join(base, "repo");
let exitCode = 1;

try {
  const c = git(["clone", "--quiet", "--no-hardlinks", root, clone]);
  report.steps.push({ step: "git clone (HEAD)", exitCode: c.exitCode, output: tail(c.stdout + c.stderr, 5) });
  if (c.exitCode !== 0) throw new Error("clone failed");

  if (includeUncommitted) {
    const diff = git(["diff", "HEAD", "--binary"]);
    const patch = join(base, "worktree.patch");
    writeFileSync(patch, diff.stdout, "utf8");
    let applied = { exitCode: 0, stdout: "", stderr: "" };
    if (diff.stdout.trim()) applied = git(["apply", "--whitespace=nowarn", patch], clone);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);
    for (const rel of untracked) {
      mkdirSync(dirname(join(clone, rel)), { recursive: true });
      cpSync(join(root, rel), join(clone, rel));
    }
    report.steps.push({ step: "apply uncommitted changes", exitCode: applied.exitCode, output: `${diff.stdout ? "tracked diff applied" : "no tracked diff"}; ${untracked.length} untracked file(s) copied${applied.stderr ? `; ${tail(applied.stderr, 5)}` : ""}` });
    if (applied.exitCode !== 0) throw new Error("applying the working-tree diff failed");
  }

  report.envFilePresent = existsSync(join(clone, ".env"));
  if (report.envFilePresent) throw new Error(".env exists in the clone; refusing to run");

  const install = run("pnpm", ["install", "--frozen-lockfile"], clone);
  report.steps.push({ step: "pnpm install --frozen-lockfile", exitCode: install.exitCode, seconds: install.seconds, output: tail(install.stdout + install.stderr, 8) });
  if (install.exitCode !== 0) throw new Error("install failed");

  const replay = run("pnpm", ["notary", "replay"], clone);
  report.steps.push({ step: "pnpm notary replay", exitCode: replay.exitCode, seconds: replay.seconds, output: tail(replay.stdout + replay.stderr, 40) });
  exitCode = replay.exitCode ?? 1;

  if (runTests) {
    const test = run("pnpm", ["test"], clone);
    report.steps.push({ step: "pnpm test", exitCode: test.exitCode, seconds: test.seconds, output: tail(test.stdout + test.stderr, 12) });
    if (test.exitCode !== 0) exitCode = 1;
  }
} catch (err) {
  report.error = err instanceof Error ? err.message : String(err);
  exitCode = 1;
} finally {
  if (keep) report.clonePath = clone;
  else rmSync(base, { recursive: true, force: true });
}

console.log(`fresh-clone check: ${report.repo} @ ${report.head.slice(0, 12)}${includeUncommitted ? " + uncommitted changes" : ""}`);
console.log(`credential-like env vars removed: ${removedVars.length ? removedVars.join(", ") : "none were set"}; .env in clone: ${report.envFilePresent ? "YES" : "no"}`);
for (const s of report.steps) {
  console.log(`\n== ${s.step}: exit ${s.exitCode}${s.seconds !== undefined ? ` (${s.seconds}s)` : ""}`);
  if (s.output) console.log(s.output);
}
if (report.error) console.log(`\nERROR: ${report.error}`);
if (report.clonePath) console.log(`\nclone kept at ${report.clonePath}`);
console.log(`\nresult: exit ${exitCode}${exitCode === 3 ? " (BLOCKED: nothing recorded to replay — not a pass)" : exitCode === 0 ? " (replay reproduced the recorded numbers exactly)" : ""}`);
process.exit(exitCode);
