/**
 * Entire (https://entire.io) for Notary: read what the real Entire CLI recorded for this repo and
 * publish it to packages/web/public/evidence/entire.json (schema/entire.ts).
 *
 * Entire's core job is checkpointing AI agent sessions next to the commits they produce: with
 * `entire enable --agent claude-code`, Claude Code hooks track each session, and the git hooks add
 * an `Entire-Checkpoint: <id>` trailer to the commit and condense the session (transcript, prompts,
 * files touched, tokens) into refs/entire/checkpoints/<id>. Notary uses that for:
 *   - the adversary `session` backend: each verdict commit (`adversary: <verdict> <beliefId>`) is
 *     checkpointed with the headless reviewer's session (adversary/session.ts reads the trailer);
 *   - the build itself: coding sessions in this repo are checkpointed the same way;
 *   - guard coverage: `entire graph edges` (guards/coverage.ts, `--backend entire`).
 *
 * Every value comes from a CLI or git call made here (verified against Entire CLI 0.11.4 and
 * entire-graph v0.4.0 on 2026-10-12):
 *   entire --version                         -> "Entire CLI 0.11.4"
 *   entire graph version --json              -> {"provider":"entire-graph","version":"v0.4.0"}
 *   entire status --json                     -> {enabled, agents: ["Claude Code"], …}
 *   entire checkpoint list --json --no-pager -> [{checkpoint_id, session_id, agent, date, message, is_logs_only, session_ids}]
 *   entire checkpoint explain <id> --json    -> {files_touched, sessions: [{model, token_usage}], …} (metadata only)
 *   git log --format=…%(trailers:key=Entire-Checkpoint,valueonly)  -> checkpoint id -> commit
 * Prompts and transcripts are never copied out of Entire.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTIRE_FILE_KIND,
  EntireCheckpointIdSchema,
  EntireFileSchema,
  type EntireCheckpoint,
  type EntireCoverage,
  type EntireFile,
} from "../schema/entire.js";
import type { CoverageReport } from "../guards/coverage.js";

export const ENTIRE_JSON_PATH = fileURLToPath(new URL("../../../web/public/evidence/entire.json", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const ENTIRE_INSTALL_HINT =
  "Install the Entire CLI (https://docs.entire.io/installation), then run `entire enable --agent claude-code` and `entire plugin install graph` in the repo";

export type ExecResult = { status: number | null; stdout: string; stderr: string; error?: Error };
/** Runs `entire <args>` (or `git <args>`) in cwd. Injectable so tests feed captured real output. */
export type Exec = (args: string[], cwd: string) => ExecResult;

const spawnExec =
  (bin: string, timeoutMs: number): Exec =>
  (args, cwd) => {
    const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
  };

export const spawnEntire: Exec = spawnExec("entire", 120_000);
export const spawnGit: Exec = spawnExec("git", 60_000);

const ok = (r: ExecResult): boolean => !r.error && r.status === 0;

function json(stdout: string): unknown {
  const body = stdout.replace(/^﻿/, "").trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ CLI facts

/** "Entire CLI 0.11.4" -> "0.11.4"; null when the CLI is missing or prints something else. */
export function entireCliVersion(exec: Exec, cwd: string): string | null {
  const r = exec(["--version"], cwd);
  if (!ok(r)) return null;
  return /Entire CLI\s+(\S+)/.exec(r.stdout)?.[1] ?? null;
}

/** The graph plugin's version ("v0.4.0"); null when the plugin is not installed. */
export function entireGraphVersion(exec: Exec, cwd: string): string | null {
  const r = exec(["graph", "version", "--json"], cwd);
  if (!ok(r)) return null;
  const v = json(r.stdout) as { version?: unknown } | undefined;
  return typeof v?.version === "string" && v.version ? v.version : null;
}

export interface EntireRepoSettings {
  enabled: boolean;
  checkpointStore: string | null;
  commitLinking: "always" | "prompt" | null;
}

/** .entire/settings.json overlaid with .entire/settings.local.json (top-level keys), as Entire layers them. */
export function readEntireSettings(repoRoot: string): EntireRepoSettings {
  const read = (name: string): Record<string, unknown> => {
    const p = join(repoRoot, ".entire", name);
    if (!existsSync(p)) return {};
    const v = json(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  const s = { ...read("settings.json"), ...read("settings.local.json") };
  const primary = ((s.checkpoints as Record<string, unknown> | undefined)?.primary ?? {}) as Record<string, unknown>;
  const linking = s.commit_linking;
  return {
    enabled: s.enabled === true,
    checkpointStore: typeof primary.type === "string" && primary.type ? primary.type : null,
    commitLinking: linking === "always" || linking === "prompt" ? linking : null,
  };
}

/** Agents with Entire hooks installed (`entire status --json`); [] when unknown. */
export function entireAgents(exec: Exec, cwd: string): string[] {
  const r = exec(["status", "--json"], cwd);
  if (!ok(r)) return [];
  const v = json(r.stdout) as { agents?: unknown } | undefined;
  return Array.isArray(v?.agents) ? v.agents.filter((a): a is string => typeof a === "string" && a.length > 0) : [];
}

// ------------------------------------------------------------------ checkpoints

export interface RawCheckpoint {
  checkpoint_id: string;
  session_id?: string;
  session_ids?: string[];
  agent?: string;
  date?: string;
  message?: string;
  is_logs_only?: boolean;
}

/** `entire checkpoint list --json --no-pager` (condensed checkpoints on the current branch). */
export function listCheckpoints(exec: Exec, cwd: string): RawCheckpoint[] {
  const r = exec(["checkpoint", "list", "--json", "--no-pager"], cwd);
  if (!ok(r)) throw new Error(`entire checkpoint list failed: ${r.error?.message ?? r.stderr.trim().split("\n").pop() ?? ""}`);
  const v = json(r.stdout);
  if (!Array.isArray(v)) throw new Error("entire checkpoint list --json did not print a JSON array");
  return v.filter((c): c is RawCheckpoint => !!c && typeof c === "object" && typeof (c as RawCheckpoint).checkpoint_id === "string");
}

export interface CheckpointDetail {
  filesTouched: string[];
  model: string | null;
  tokens: EntireCheckpoint["tokens"];
}

/** `entire checkpoint explain <id> --json`: metadata only (Entire never embeds transcripts in it). */
export function explainCheckpoint(exec: Exec, cwd: string, id: string): CheckpointDetail | null {
  const r = exec(["checkpoint", "explain", id, "--json"], cwd);
  if (!ok(r)) return null;
  const v = json(r.stdout) as
    | {
        files_touched?: unknown;
        sessions?: Array<{
          model?: unknown;
          token_usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number; api_call_count?: number };
        }>;
      }
    | undefined;
  if (!v || typeof v !== "object") return null;
  const files = Array.isArray(v.files_touched) ? v.files_touched.filter((f): f is string => typeof f === "string" && f.length > 0) : [];
  const sessions = Array.isArray(v.sessions) ? v.sessions : [];
  const model = sessions.map((s) => s.model).find((m): m is string => typeof m === "string" && m.length > 0) ?? null;
  const usages = sessions.map((s) => s.token_usage).filter((u): u is NonNullable<typeof u> => !!u && typeof u === "object");
  const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);
  const tokens = usages.length
    ? usages.reduce(
        (acc, u) => ({
          input: acc.input + n(u.input_tokens),
          output: acc.output + n(u.output_tokens),
          cacheRead: acc.cacheRead + n(u.cache_read_tokens),
          cacheCreation: acc.cacheCreation + n(u.cache_creation_tokens),
          apiCalls: acc.apiCalls + n(u.api_call_count),
        }),
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, apiCalls: 0 },
      )
    : null;
  return { filesTouched: [...new Set(files)].sort(), model, tokens };
}

export interface CheckpointCommit {
  sha: string;
  subject: string;
}

/** checkpoint id -> commit (sha, subject), from the `Entire-Checkpoint` trailers on the current branch. */
export function checkpointCommits(git: Exec, cwd: string): Map<string, CheckpointCommit> {
  const r = git(["log", "--format=%H%x1f%s%x1f%(trailers:key=Entire-Checkpoint,valueonly,separator=%x2C)%x1e"], cwd);
  const out = new Map<string, CheckpointCommit>();
  if (!ok(r)) return out;
  for (const rec of r.stdout.split("\x1e")) {
    const [sha, subject, ids] = rec.trim().split("\x1f");
    if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !ids) continue;
    for (const id of ids.split(",").map((x) => x.trim()).filter(Boolean)) if (!out.has(id)) out.set(id, { sha, subject: subject ?? "" });
  }
  return out;
}

/** `adversary: <verdict> <beliefId>` (adversary/session.ts commit message) -> the review it records. */
export function parseAdversaryCommit(subject: string): EntireCheckpoint["review"] {
  const m = /^adversary: (uphold|narrow|downgrade) (\S+)$/.exec(subject.trim());
  return m ? { verdict: m[1] as "uphold" | "narrow" | "downgrade", beliefId: m[2]! } : null;
}

/**
 * One published checkpoint. Only a COMMITTED checkpoint is published: its id must be a checkpoint id
 * (ULID or legacy 12-hex) carried by an `Entire-Checkpoint` trailer on this branch. While a session
 * is live, `entire checkpoint list` also returns its temporary shadow-branch snapshots (40-hex ids)
 * whose `message` is the session's latest prompt text; those are never published, and the message
 * shown is always the commit subject from git, never Entire's copy.
 */
export function toCheckpoint(raw: RawCheckpoint, detail: CheckpointDetail | null, commit: CheckpointCommit | undefined): EntireCheckpoint | null {
  if (!commit || !EntireCheckpointIdSchema.safeParse(raw.checkpoint_id).success) return null;
  const at = raw.date ? new Date(raw.date) : undefined;
  if (!at || Number.isNaN(at.getTime())) return null;
  const sessionIds = [...new Set([...(raw.session_ids ?? []), ...(raw.session_id ? [raw.session_id] : [])].filter((x) => typeof x === "string" && x.length > 0))];
  if (!sessionIds.length) return null;
  const message = commit.subject;
  const review = parseAdversaryCommit(message);
  return {
    id: raw.checkpoint_id,
    at: at.toISOString(),
    agent: raw.agent && raw.agent.trim() ? raw.agent.trim() : "unknown",
    sessionIds,
    model: detail?.model ?? null,
    commit: commit.sha,
    message,
    filesTouched: detail?.filesTouched ?? [],
    tokens: detail?.tokens ?? null,
    kind: review ? "adversary-review" : "coding-session",
    review,
    logsOnly: raw.is_logs_only === true,
  };
}

// ------------------------------------------------------------------ coverage

export function toEntireCoverage(report: CoverageReport): EntireCoverage | null {
  if (report.backend !== "entire" || !report.entire) return null;
  const g = report.entire;
  const unguarded = [...report.sites, ...report.createToolsCalls]
    .filter((s) => s.status === "UNGUARDED")
    .map((s) => ({ op: s.op, file: s.file, line: s.line, detail: s.detail }));
  return {
    backend: "entire",
    command: g.command,
    graphProvider: g.provider,
    graphVersion: g.providerVersion,
    commit: g.commit && /^[0-9a-f]{40}$/.test(g.commit) ? g.commit : null,
    worktree: g.worktree,
    completeness: g.completeness,
    skippedFiles: g.skippedFiles,
    callEdges: g.callEdges,
    constructEdges: g.constructEdges,
    clientEdges: g.clientEdges,
    ops: report.totals.ops,
    sites: report.totals.sites,
    guarded: report.totals.guarded,
    rawByDesign: report.totals.rawByDesign,
    unguardedCallSites: report.unguarded_call_sites,
    unguarded,
  };
}

// ------------------------------------------------------------------ the file

export interface CollectEntireOptions {
  repoRoot?: string;
  entire?: Exec;
  git?: Exec;
  /** Runs guard coverage with the entire backend; null skips it (coverageNote says so). */
  coverage?: (() => CoverageReport) | null;
}

export function collectEntireFile(opts: CollectEntireOptions = {}): EntireFile {
  const root = opts.repoRoot ?? REPO_ROOT;
  const entire = opts.entire ?? spawnEntire;
  const git = opts.git ?? spawnGit;
  const head = git(["rev-parse", "HEAD"], root);
  const repoHead = ok(head) && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
  const br = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const branch = ok(br) && br.stdout.trim() && br.stdout.trim() !== "HEAD" ? br.stdout.trim() : null;
  const settings = readEntireSettings(root);

  const version = entireCliVersion(entire, root);
  if (!version) {
    return EntireFileSchema.parse({
      kind: ENTIRE_FILE_KIND,
      repoHead,
      branch,
      cli: { installed: false, version: null, graphPlugin: null },
      repo: { enabled: settings.enabled, agents: [], checkpointStore: settings.checkpointStore, commitLinking: settings.commitLinking },
      checkpoints: [],
      checkpointsNote: `The Entire CLI is not on PATH on the machine that ran the export. ${ENTIRE_INSTALL_HINT}.`,
      coverage: null,
      coverageNote: "Guard coverage with the entire backend needs the Entire CLI and its graph plugin.",
    });
  }
  const graphPlugin = entireGraphVersion(entire, root);
  const agents = entireAgents(entire, root);

  let checkpoints: EntireCheckpoint[] = [];
  let checkpointsNote: string | null = null;
  if (!settings.enabled) {
    checkpointsNote = "Entire is installed but not enabled in this repo. Run `entire enable --agent claude-code`, then work with Claude Code and commit: each commit gets an Entire-Checkpoint trailer.";
  } else {
    try {
      const commits = checkpointCommits(git, root);
      checkpoints = listCheckpoints(entire, root)
        // Committed checkpoints only (never a live session's shadow snapshots; see toCheckpoint).
        .filter((raw) => commits.has(raw.checkpoint_id) && EntireCheckpointIdSchema.safeParse(raw.checkpoint_id).success)
        .map((raw) => toCheckpoint(raw, explainCheckpoint(entire, root, raw.checkpoint_id), commits.get(raw.checkpoint_id)))
        .filter((c): c is EntireCheckpoint => c !== null)
        .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : b.at.localeCompare(a.at)));
      if (!checkpoints.length) {
        checkpointsNote = `Entire is enabled (${agents.join(", ") || "no agent hooks"}), but no commit on ${branch ?? "this branch"} carries an Entire-Checkpoint trailer yet. One is created when a commit is made while Entire tracks an agent session: commit after a Claude Code session in this repo, or run \`pnpm notary notarize --tool <name> --adversary session\`, whose verdict commits are checkpointed.`;
      }
    } catch (err) {
      checkpoints = [];
      checkpointsNote = `Could not read Entire checkpoints: ${(err as Error).message}`;
    }
  }

  let coverage: EntireCoverage | null = null;
  let coverageNote: string | null = null;
  if (!graphPlugin) {
    coverageNote = "The entire-graph plugin is not installed. Run `entire plugin install graph`.";
  } else if (opts.coverage === null) {
    coverageNote = "Guard coverage was skipped for this export (--no-checks). Run `pnpm notary export --entire` to include it.";
  } else {
    try {
      const run = opts.coverage ?? (() => {
        throw new Error("no coverage runner");
      });
      coverage = toEntireCoverage(run());
      if (!coverage) coverageNote = "Guard coverage did not run on the entire backend.";
    } catch (err) {
      coverageNote = `Guard coverage with the entire backend failed: ${(err as Error).message.split("\n")[0]}`;
    }
  }

  return EntireFileSchema.parse({
    kind: ENTIRE_FILE_KIND,
    repoHead,
    branch,
    cli: { installed: true, version, graphPlugin },
    repo: { enabled: settings.enabled, agents, checkpointStore: settings.checkpointStore, commitLinking: settings.commitLinking },
    checkpoints,
    checkpointsNote,
    coverage,
    coverageNote,
  });
}

/** `notary export --entire`: write packages/web/public/evidence/entire.json from the real CLI. */
export function writeEntireFile(opts: CollectEntireOptions & { path?: string } = {}): { path: string; file: EntireFile; lines: string[] } {
  const path = opts.path ?? ENTIRE_JSON_PATH;
  const file = collectEntireFile(opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  const reviews = file.checkpoints.filter((c) => c.kind === "adversary-review").length;
  const lines = [
    `entire: ${path}`,
    `  cli: ${file.cli.installed ? `Entire CLI ${file.cli.version}, graph plugin ${file.cli.graphPlugin ?? "not installed"}` : "not installed"}; repo ${file.repo.enabled ? "enabled" : "not enabled"}`,
    `  checkpoints: ${file.checkpoints.length} (${reviews} adversary reviews)${file.checkpointsNote ? ` — ${file.checkpointsNote}` : ""}`,
    `  coverage: ${file.coverage ? `unguarded_call_sites = ${file.coverage.unguardedCallSites} (${file.coverage.callEdges} call relations scanned)` : file.coverageNote}`,
  ];
  return { path, file, lines };
}
