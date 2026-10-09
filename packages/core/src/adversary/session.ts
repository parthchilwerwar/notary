/**
 * `session` adversary backend: a headless Claude Code run inside the repo whose verdict file is
 * committed, so Entire checkpoints the review next to the belief (TDD step 8, PRD Entire row).
 *
 *   1. write the evidence packet to <repoRoot>/adversary/inbox/<beliefId>.json
 *   2. run `claude -p "<fixed reviewer prompt>" --output-format json` with only the Read and Write
 *      tools, pre-approved for exactly the inbox file (Read) and the verdict file (Edit rules cover
 *      Write), `--permission-mode dontAsk` so anything else is denied instead of prompting, .env
 *      reads denied explicitly, and no MCP servers or slash commands
 *   3. read + zod-validate <repoRoot>/adversary/verdicts/<beliefId>.json
 *   4. take the session id from the CLI's JSON result (`session_id`)
 *   5. if `commit` (default), `git add` both files and commit only those paths
 *
 * Flags verified against `claude --help` (Claude Code 2.1.296): -p/--print, --output-format json,
 * --tools, --allowedTools, --disallowedTools, --permission-mode dontAsk, --strict-mcp-config,
 * --disable-slash-commands.
 *
 * Fail safe: every failure (CLI missing, timeout, non-zero exit, missing/invalid verdict file,
 * git failure) returns {review: null, failure}; nothing throws. The child process gets the
 * parent's env minus secret-looking variables it has no use for (tool API keys, tracing tokens);
 * the prompt contains only fixed text and repo-relative paths.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AdversaryReview } from "../schema/index.js";
import { SAFE_ID_RE, reviewReason, sessionReviewerPrompt, validateReply } from "./prompt.js";
import type { GitRunner, ProcessResult, ReviewOutcome, SessionRunner } from "./types.js";

type Env = Record<string, string | undefined>;

export const SESSION_MODEL = "claude-code-session";
export const CLAUDE_COMMAND = "claude";
export const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** Secret-looking vars Claude Code itself may need to authenticate (direct API or Bedrock). */
const CLAUDE_AUTH_ENV_RE = /^(ANTHROPIC_|CLAUDE_|AWS_)/i;
const MAX_OUTPUT_CHARS = 1_000_000;

export function inboxRelPath(beliefId: string): string {
  return `adversary/inbox/${beliefId}.json`;
}

export function verdictRelPath(beliefId: string): string {
  return `adversary/verdicts/${beliefId}.json`;
}

/** The exact argv passed to `claude` (exported for tests and the report). */
export function claudeArgs(beliefId: string): string[] {
  const inbox = inboxRelPath(beliefId);
  const verdict = verdictRelPath(beliefId);
  return [
    "-p",
    sessionReviewerPrompt(inbox, verdict),
    "--output-format",
    "json",
    "--tools",
    "Read,Write",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--disallowedTools",
    "Read(./.env),Read(./.env.*),Read(**/.env),Read(**/.env.*)",
    "--allowedTools",
    `Read(./${inbox}),Edit(./${verdict})`,
  ];
}

/** Parent env without secrets the reviewer has no use for. */
export function childEnv(env: Env): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(k) && !CLAUDE_AUTH_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function collect(
  command: string,
  args: string[],
  opts: { cwd: string; env: Env; timeoutMs?: number },
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      finish({ exitCode: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString("utf8");
    });
    child.on("error", (err) => finish({ exitCode: null, stdout, stderr: `${stderr}${err.message}`, timedOut }));
    child.on("close", (code) => finish({ exitCode: code, stdout, stderr, timedOut }));
  });
}

/** Default runner: spawns the real `claude` CLI (no shell) with a timeout. */
export const spawnSessionRunner: SessionRunner = (req) =>
  collect(req.command, req.args, { cwd: req.cwd, env: req.env, timeoutMs: req.timeoutMs });

/** Default git runner: `git <args>` in `cwd`, no shell. */
export const spawnGitRunner: GitRunner = (args, cwd) =>
  collect("git", args, { cwd, env: process.env, timeoutMs: 60_000 });

/** Nearest ancestor of `start` holding a `.git` entry; `start` itself when there is none. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

function tail(s: string, n = 400): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** `session_id` (and error flag) from `claude -p --output-format json` stdout. */
export function parseSessionResult(stdout: string): { sessionId?: string; isError: boolean; subtype?: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    // Some versions print log lines before the result; take the last line that parses as an object.
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
      try {
        value = JSON.parse(line);
        break;
      } catch {
        // keep looking
      }
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { isError: false };
  const rec = value as Record<string, unknown>;
  const sessionId = typeof rec.session_id === "string" && rec.session_id.trim() ? rec.session_id.trim() : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    isError: rec.is_error === true,
    ...(typeof rec.subtype === "string" ? { subtype: rec.subtype } : {}),
  };
}

export async function reviewWithSession(args: {
  beliefId: string;
  packetJson: string;
  repoRoot?: string;
  commit?: boolean;
  sessionRunner?: SessionRunner;
  gitRunner?: GitRunner;
  timeoutMs?: number;
  env?: Env;
  now?: () => Date;
}): Promise<ReviewOutcome> {
  const fail = (failure: string): ReviewOutcome => ({ review: null, failure: `adversary (session): ${failure}` });
  const { beliefId } = args;
  if (!SAFE_ID_RE.test(beliefId)) return fail(`belief id ${JSON.stringify(beliefId)} is not safe for a file name`);

  const repoRoot = resolve(args.repoRoot ?? findRepoRoot());
  const inboxRel = inboxRelPath(beliefId);
  const verdictRel = verdictRelPath(beliefId);
  const inboxAbs = join(repoRoot, ...inboxRel.split("/"));
  const verdictAbs = join(repoRoot, ...verdictRel.split("/"));

  try {
    await mkdir(dirname(inboxAbs), { recursive: true });
    await mkdir(dirname(verdictAbs), { recursive: true });
    // Never read a verdict left over from an earlier review (it stays in git history if committed).
    await rm(verdictAbs, { force: true });
    await writeFile(inboxAbs, `${args.packetJson}\n`, "utf8");
  } catch (err) {
    return fail(`could not prepare inbox: ${err instanceof Error ? err.message : String(err)}`);
  }

  const runner = args.sessionRunner ?? spawnSessionRunner;
  let run: ProcessResult;
  try {
    run = await runner({
      command: CLAUDE_COMMAND,
      args: claudeArgs(beliefId),
      cwd: repoRoot,
      timeoutMs: args.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      env: childEnv(args.env ?? process.env),
    });
  } catch (err) {
    return fail(`session runner failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (run.timedOut) return fail(`claude session timed out`);
  if (run.exitCode !== 0) {
    return fail(`claude exited with ${run.exitCode ?? "no exit code"}${run.stderr ? `: ${tail(run.stderr)}` : ""}`);
  }
  const result = parseSessionResult(run.stdout);
  if (result.isError) return fail(`claude reported an error result${result.subtype ? ` (${result.subtype})` : ""}`);

  let verdictText: string;
  try {
    verdictText = await readFile(verdictAbs, "utf8");
  } catch {
    return fail(`no verdict file at ${verdictRel}`);
  }
  let verdictValue: unknown;
  try {
    verdictValue = JSON.parse(verdictText);
  } catch {
    return fail(`verdict file ${verdictRel} is not valid JSON`);
  }
  const parsed = validateReply(verdictValue);
  if (!parsed.ok) return fail(`${verdictRel}: ${parsed.failure}`);

  const review: AdversaryReview = {
    verdict: parsed.reply.verdict,
    reason: reviewReason(parsed.reply),
    model: SESSION_MODEL,
    backend: "session",
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(parsed.reply.scope ? { scope: parsed.reply.scope } : {}),
    reviewedAt: (args.now ?? (() => new Date()))().toISOString(),
  };

  if (args.commit ?? true) {
    const git = args.gitRunner ?? spawnGitRunner;
    const paths = [verdictRel, inboxRel];
    try {
      const add = await git(["add", "--", ...paths], repoRoot);
      if (add.exitCode !== 0) return fail(`git add failed: ${tail(add.stderr || add.stdout)}`);
      // Commit only these two paths, whatever else is staged.
      const commit = await git(["commit", "-m", `adversary: ${review.verdict} ${beliefId}`, "--", ...paths], repoRoot);
      if (commit.exitCode !== 0) return fail(`git commit failed: ${tail(commit.stderr || commit.stdout)}`);
    } catch (err) {
      return fail(`git failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { review };
}
