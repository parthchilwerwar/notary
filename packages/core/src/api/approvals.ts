// GET/POST /api/approvals (v2 approval desk, local `notary serve` only; token + localhost via session.ts).
//
// GET  -> ApprovalsList: `testMode` (the Dodo test-mode lock state), `pending` = held decisions with a
//         write action from LOCAL runs (runs/<runId>/ bundles: verified, sample false, guarded, live;
//         fixture/demo bundles are simulated and never listed) minus the ones already decided, and
//         `decided` = every record in runs/<runId>/approvals.json.
// POST -> ApprovalRequest.
//   rejected: a non-empty reason; closes the item (status "closed"); no external call; keyless.
//   approved: only under the Dodo test-mode lock; `confirmedAmount` (typed by the human) must equal
//     the held action's amount in minor units; at most once per decision (an existing record -> 409);
//     no DODO_PAYMENTS_API_KEY -> 503 "BLOCKED: DODO_PAYMENTS_API_KEY not set" and nothing recorded.
//     The held request runs once more through executeQueue's GUARDED path with `humanOverride: true`:
//     the guarded Dodo clients (guards compiled from the Notary store, every guard still applies),
//     the executor's pre-write reads (existing refunds, ledger snapshot), its idempotency key and its
//     read-back-before-retry rule. Only the certificate / required-beliefs gate is bypassed. The tier
//     is the one recorded on the held decision (no Crustdata call); the policy is re-run and, before
//     any write, must still pick the held action for exactly the confirmed amount (Dodo's live amount),
//     else nothing is written and the record says why ("failed").
//
// Every decision is written to runs/<runId>/approvals.json (atomic write), runs inside one span
// "notary.approval" (sunk to runs/<runId>/spans.jsonl), is appended to runs/<runId>/timeline.jsonl as
// an `approval.decided` event and emitted on the server's bus as a "timeline" event.
// Decisions are serialized in-process, so two concurrent approvals of one item cannot both execute.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Hono } from "hono";
import { ApprovalRequestSchema, ApprovalsFileSchema, ApprovalsListSchema } from "../schema/approval.js";
import type { ApprovalRecord, ApprovalRequest, ApprovalsFile, ApprovalsList, PendingApproval } from "../schema/approval.js";
import type { Decision, QueueRequest, RunBundle } from "../schema/index.js";
import type { TimelineEvent } from "../schema/timeline.js";
import { executeQueue } from "../queue/executor.js";
import type { PolicyFns, QueueTools } from "../queue/executor.js";
import { loadManifest, resolveEntry, isRef } from "../queue/manifest.js";
import type { SeedManifest } from "../queue/manifest.js";
import { decidePolicy } from "../queue/policy.js";
import type { PolicyDecision, PolicyInput } from "../queue/policy.js";
import { loadGuardedContext } from "../queue/run.js";
import { DEFAULT_DB_PATH, openDb } from "../store/db.js";
import type { NotaryDb } from "../store/db.js";
import { appendTimelineEvents } from "../timeline/store.js";
import { CreditLedger, DODO_TEST_BASE_URL, TestModeLockError, assertTestMode, createTools, isBlocked } from "../tools/index.js";
import type { Wrap } from "../tools/index.js";
import { flushTracing, setSpanSink, spanSinkPath, withSpan } from "../trace/index.js";
import { bus as defaultBus } from "./bus.js";
import type { EventBus } from "./bus.js";
import { loadVerifiedBundles, runSubdirectories } from "./bundle-source.js";
import { requireLocalSession } from "./session.js";
import type { ApiSession } from "./session.js";

export const APPROVALS_FILE = "approvals.json";
export const WRITE_ACTIONS: readonly string[] = ["dodo.createRefund", "dodo.changeSubscriptionPlan", "dodo.createWalletLedgerEntry"];
export const DODO_KEY_BLOCKED = "BLOCKED: DODO_PAYMENTS_API_KEY not set";

export interface ApprovalsOptions {
  /** runs/ (each immediate subdirectory is one run). null: no local runs. */
  runsDir: string | null;
  env?: NodeJS.ProcessEnv;
  /** The server's bus (the appended timeline event is emitted as "timeline"). Default: the process bus. */
  bus?: EventBus;
  now?: () => Date;
  /** Seed manifest (refs -> Dodo ids, payment amounts, product prices). Default: loaded lazily. */
  manifest?: SeedManifest;
  manifestPath?: string;
  /** The Notary store the guards are compiled from. Default runs/notary.sqlite. */
  db?: NotaryDb;
  dbPath?: string;
  cassetteDir?: string;
  /** Test seam: the Dodo/Crustdata tools built from the guarded wrap (default: createTools live). */
  makeTools?: (wrap: Wrap) => QueueTools;
  /** Test seam: the policy function (default: the real policy table). */
  decidePolicy?: (input: PolicyInput) => PolicyDecision;
}

export interface HeldItem {
  bundle: RunBundle;
  runDir: string;
  decision: Decision;
  request: QueueRequest;
}

/** "appr-" + sha256(runId \n decisionId)[:16]: one record per held decision. */
export function approvalIdFor(runId: string, decisionId: string): string {
  return `appr-${createHash("sha256").update(`${runId}\n${decisionId}`).digest("hex").slice(0, 16)}`;
}

/** The Dodo test-mode lock state, without constructing a client. */
export function dodoTestMode(env: NodeJS.ProcessEnv): { testMode: boolean; reason?: string } {
  try {
    assertTestMode("live", env.DODO_BASE_URL?.trim() || DODO_TEST_BASE_URL, env);
    return { testMode: true };
  } catch (err) {
    return { testMode: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function readApprovalsFile(runDir: string, runId: string): ApprovalsFile {
  const path = join(runDir, APPROVALS_FILE);
  if (!existsSync(path)) return { runId, approvals: [] };
  const parsed = ApprovalsFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid approvals file (${parsed.error.issues[0]?.message ?? "invalid"})`);
  if (parsed.data.runId !== runId) throw new Error(`${path} belongs to run ${parsed.data.runId}, not ${runId}`);
  return parsed.data;
}

/** Atomic: write a temp file next to it, then rename over. */
export function writeApprovalsFile(runDir: string, file: ApprovalsFile): void {
  const clean = ApprovalsFileSchema.parse(file);
  const path = join(runDir, APPROVALS_FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Local run bundles that can hold actions: verified, real (sample false), guarded, live, kind run. */
async function localRuns(runsDir: string | null): Promise<Array<{ bundle: RunBundle; runDir: string }>> {
  const out: Array<{ bundle: RunBundle; runDir: string }> = [];
  for (const dir of runSubdirectories(runsDir)) {
    for (const { bundle } of await loadVerifiedBundles([dir])) {
      // runs/<runId>/ holds that run's bundle; anything else in the index is not this run's to approve.
      if (bundle.runId !== basename(dir)) continue;
      if (bundle.sample || bundle.kind !== "run" || bundle.variant !== "guarded" || bundle.mode !== "live") continue;
      out.push({ bundle, runDir: dir });
    }
  }
  return out;
}

export async function heldItems(runsDir: string | null): Promise<HeldItem[]> {
  const out: HeldItem[] = [];
  for (const { bundle, runDir } of await localRuns(runsDir)) {
    for (const decision of bundle.decisions) {
      if (decision.status !== "held" || !WRITE_ACTIONS.includes(decision.action)) continue;
      const request = bundle.queue.find((q) => q.id === decision.requestId);
      if (!request) continue;
      out.push({ bundle, runDir, decision, request });
    }
  }
  return out;
}

function tryManifest(opts: ApprovalsOptions): SeedManifest | undefined {
  if (opts.manifest) return opts.manifest;
  try {
    return loadManifest(opts.manifestPath);
  } catch {
    return undefined;
  }
}

/** The seeded payment's amount for a "pay:" ref, when the manifest has it. */
function manifestPayment(manifest: SeedManifest | undefined, ref: string | undefined): { amount: number; currency: string } | undefined {
  if (!manifest || !ref || !isRef(ref)) return undefined;
  try {
    const e = resolveEntry(manifest, ref);
    return e.kind === "pay" ? { amount: e.entry.amount, currency: e.entry.currency } : undefined;
  } catch {
    return undefined;
  }
}

function manifestProduct(manifest: SeedManifest | undefined, target: string | undefined): { amount: number; currency: string } | undefined {
  if (!manifest || !target) return undefined;
  try {
    if (isRef(target)) {
      const e = resolveEntry(manifest, target);
      return e.kind === "prod" ? { amount: e.entry.price, currency: e.entry.currency } : undefined;
    }
  } catch {
    return undefined;
  }
  const p = manifest.products[target];
  return p ? { amount: p.price, currency: p.currency } : undefined;
}

/**
 * The amount (minor units) the held action would move, computed by code: the policy re-run on the
 * held decision's tier with the request's amount and the seeded payment total; for a plan change, the
 * target product's price. undefined when it can't be told from the records.
 */
export function heldAmount(
  item: { decision: Decision; request: QueueRequest },
  manifest: SeedManifest | undefined,
  policy: (input: PolicyInput) => PolicyDecision = decidePolicy,
): { amount?: number; currency?: string } {
  const { decision, request } = item;
  if (decision.action === "dodo.changeSubscriptionPlan") {
    const p = manifestProduct(manifest, request.targetPlan);
    return p ? { amount: p.amount, currency: p.currency } : {};
  }
  const pay = manifestPayment(manifest, request.paymentId);
  const d = policy({
    tier: decision.tier,
    plan: request.plan,
    type: request.type,
    ...(request.amount === undefined ? {} : { amount: request.amount }),
    ...(pay ? { paymentAmount: pay.amount } : {}),
  });
  if (d.action !== decision.action) return {};
  const amount = d.refundAmount ?? (decision.action === "dodo.createRefund" ? pay?.amount : undefined);
  const currency = request.currency ?? pay?.currency ?? (decision.action === "dodo.createWalletLedgerEntry" ? "USD" : undefined);
  return { ...(amount === undefined ? {} : { amount }), ...(currency ? { currency } : {}) };
}

export async function listApprovals(opts: ApprovalsOptions): Promise<ApprovalsList> {
  const env = opts.env ?? process.env;
  const manifest = tryManifest(opts);
  const decided: ApprovalRecord[] = [];
  for (const { bundle, runDir } of await localRuns(opts.runsDir)) {
    try {
      decided.push(...readApprovalsFile(runDir, bundle.runId).approvals);
    } catch {
      // An unreadable approvals file is skipped here; POST refuses to touch it.
    }
  }
  const decidedIds = new Set(decided.map((r) => r.id));
  const pending: PendingApproval[] = [];
  for (const item of await heldItems(opts.runsDir)) {
    if (decidedIds.has(approvalIdFor(item.bundle.runId, item.decision.id))) continue;
    const { amount, currency } = heldAmount(item, manifest, opts.decidePolicy);
    pending.push({
      runId: item.bundle.runId,
      decisionId: item.decision.id,
      requestId: item.request.id,
      action: item.decision.action,
      ...(amount === undefined ? {} : { amount }),
      ...(currency ? { currency } : {}),
      reason: item.decision.error ?? item.decision.evidencePack?.reason ?? "held",
      missingBeliefs: item.decision.missingBeliefs,
    });
  }
  return ApprovalsListSchema.parse({ testMode: dodoTestMode(env).testMode, pending, decided });
}

// ------------------------------------------------------------------------------------- decide

export type DecideResult = { status: 200 | 400 | 403 | 404 | 409 | 500 | 503; body: unknown };

let chain: Promise<unknown> = Promise.resolve();

/** Serialize decisions in this process (at most once per decision, even under concurrent requests). */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function isBlockedError(err: unknown): boolean {
  return isBlocked(err) || err instanceof TestModeLockError || (err instanceof Error && err.message.startsWith("BLOCKED:"));
}

function summaryFor(rec: ApprovalRecord): string {
  const amt = rec.confirmedAmount === undefined ? "" : ` (${rec.confirmedAmount}${rec.currency ? ` ${rec.currency}` : ""} minor units)`;
  if (rec.decision === "rejected") return `A human rejected ${rec.action} for ${rec.requestId}: ${(rec.reason ?? "").slice(0, 200)}.`;
  if (rec.status === "executed") return `A human approved ${rec.action} for ${rec.requestId}${amt}; it executed once through the guarded clients (human override of the gate).`;
  return `A human approved ${rec.action} for ${rec.requestId}${amt}; execution failed: ${(rec.error ?? "unknown error").slice(0, 200)}.`;
}

export async function decideApproval(body: unknown, opts: ApprovalsOptions): Promise<DecideResult> {
  const parsed = ApprovalRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: `invalid approval request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` } };
  }
  return serialized(() => decideLocked(parsed.data, opts));
}

async function decideLocked(req: ApprovalRequest, opts: ApprovalsOptions): Promise<DecideResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const item = (await heldItems(opts.runsDir)).find((h) => h.bundle.runId === req.runId && h.decision.id === req.decisionId);
  if (!item) return { status: 404, body: { error: `no held decision ${req.decisionId} in local run ${req.runId}` } };

  const id = approvalIdFor(item.bundle.runId, item.decision.id);
  let file: ApprovalsFile;
  try {
    file = readApprovalsFile(item.runDir, item.bundle.runId);
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
  const existing = file.approvals.find((r) => r.id === id);
  if (existing) return { status: 409, body: { error: `decision ${req.decisionId} was already ${existing.decision} (${existing.status})`, approval: existing } };

  const base = { id, runId: item.bundle.runId, decisionId: item.decision.id, requestId: item.request.id, action: item.decision.action, humanOverride: true as const };

  if (req.decision === "approved") {
    const lock = dodoTestMode(env);
    if (!lock.testMode) return { status: 403, body: { error: `refused: approvals execute only in Dodo test mode (${lock.reason ?? "test mode off"})` } };
    const manifest = tryManifest(opts);
    const held = heldAmount(item, manifest, opts.decidePolicy);
    if (held.amount === undefined) {
      return { status: 400, body: { error: `the held action's amount can't be told from the records (no seed manifest entry); nothing to confirm against` } };
    }
    if (req.confirmedAmount !== held.amount) {
      return { status: 400, body: { error: `confirmedAmount ${req.confirmedAmount} does not equal the held amount ${held.amount} (minor units)`, heldAmount: held.amount } };
    }
    if (!(env.DODO_PAYMENTS_API_KEY ?? "").trim()) return { status: 503, body: { error: DODO_KEY_BLOCKED } };
    if (!manifest) return { status: 503, body: { error: "BLOCKED: no seed manifest — run scripts/seed-dodo.ts with Dodo test keys" } };
  }

  return await withRunSpanSink(item.runDir, async () => {
    let traceId: string | undefined;
    let setAttr: ((k: string, v: string | number | boolean) => void) | undefined;
    let record: ApprovalRecord | { blocked: string };
    record = await withSpan(
      "notary.approval",
      {
        "notary.approval.id": id,
        "notary.approval.run": item.bundle.runId,
        "notary.approval.decisionId": item.decision.id,
        "notary.approval.decision": req.decision,
        "notary.approval.action": item.decision.action,
        "notary.approval.humanOverride": true,
      },
      async (): Promise<ApprovalRecord | { blocked: string }> => {
        let rec: ApprovalRecord | { blocked: string };
        if (req.decision === "rejected") {
          rec = { ...base, decision: "rejected", reason: req.reason.trim(), effects: [], status: "closed", decidedAt: now().toISOString() };
        } else {
          rec = await executeApproved(item, req.confirmedAmount, base, opts);
        }
        if ("blocked" in rec) setAttr?.("notary.approval.status", "blocked");
        else setAttr?.("notary.approval.status", rec.status);
        return rec;
      },
      { kind: "GUARDRAIL", onSpan: (ids, set) => ((traceId = ids.traceId), (setAttr = set)) },
    );
    await flushTracing();
    if ("blocked" in record) return { status: 503, body: { error: record.blocked } } satisfies DecideResult;
    if (traceId) record = { ...record, traceId };

    writeApprovalsFile(item.runDir, { runId: file.runId, approvals: [...file.approvals, record] });

    let event: TimelineEvent | undefined;
    try {
      [event] = appendTimelineEvents(item.runDir, [
        {
          runId: record.runId,
          at: record.decidedAt,
          stage: "enforce",
          type: "approval.decided",
          recordIds: [record.id, record.decisionId],
          traceIds: record.traceId ? [record.traceId] : [],
          summary: summaryFor(record),
          data: {
            decision: record.decision,
            ...(record.confirmedAmount === undefined ? {} : { amount: record.confirmedAmount }),
            ...(record.currency ? { currency: record.currency } : {}),
            status: record.status,
          },
        },
      ]);
    } catch (err) {
      console.warn(`approval ${record.id}: timeline append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (event) (opts.bus ?? defaultBus).emit("timeline", event);
    return { status: 200, body: record } satisfies DecideResult;
  });
}

/** Sink this decision's spans into runs/<runId>/spans.jsonl (restored after; decisions are serialized). */
async function withRunSpanSink<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = spanSinkPath();
  setSpanSink(join(runDir, "spans.jsonl"));
  try {
    return await fn();
  } finally {
    setSpanSink(previous);
  }
}

async function executeApproved(
  item: HeldItem,
  confirmedAmount: number,
  base: Pick<ApprovalRecord, "id" | "runId" | "decisionId" | "requestId" | "action" | "humanOverride">,
  opts: ApprovalsOptions,
): Promise<ApprovalRecord | { blocked: string }> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const manifest = opts.manifest ?? loadManifest(opts.manifestPath);
  const held = heldAmount(item, manifest, opts.decidePolicy);
  const policyFn = opts.decidePolicy ?? decidePolicy;
  const { decision, request } = item;

  // The tier recorded on the held decision (no re-enrichment); the policy must still pick the held
  // action for exactly the amount the human confirmed, against Dodo's live payment total.
  const pinned: PolicyFns = {
    tierFromCompany: () => ({ tier: decision.tier, basis: `tier recorded on held decision ${decision.id} (approval: no re-enrichment)` }),
    decidePolicy: (input) => {
      const d = policyFn(input);
      if (d.outcome === "deny" || d.outcome === "escalate" || d.action !== decision.action) {
        return { outcome: "escalate", action: "none", reason: `approval refused before any write: the policy now says ${d.outcome} ${d.action} (${d.reason}); the held action was ${decision.action}` };
      }
      if (decision.action !== "dodo.changeSubscriptionPlan") {
        const live = d.refundAmount ?? (decision.action === "dodo.createRefund" ? input.paymentAmount : undefined);
        if (live !== confirmedAmount) {
          return { outcome: "escalate", action: "none", reason: `approval refused before any write: the action would move ${live ?? "an unknown amount"}, the human confirmed ${confirmedAmount} (minor units)` };
        }
      }
      return d;
    },
  };

  const ownDb = !opts.db;
  let db: NotaryDb | undefined;
  let unwire: (() => void) | undefined;
  const decidedAt = (): string => now().toISOString();
  const money = { confirmedAmount, ...(held.currency ? { currency: held.currency } : {}) };
  try {
    db = opts.db ?? openDb(opts.dbPath ?? DEFAULT_DB_PATH);
    const gctx = loadGuardedContext(db, now);
    unwire = gctx.unwire;
    const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const built: QueueTools =
      opts.makeTools?.(gctx.wrap) ??
      createTools({
        mode: "live",
        cassette: `${item.bundle.runId}-approval-${request.id}-${stamp}`.replace(/[^A-Za-z0-9._-]/g, "_"),
        ledger: new CreditLedger({ env }),
        env,
        wrap: gctx.wrap,
        ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }),
      });
    // No Crustdata call: the tier is pinned above, so enrichment answers "no match" locally.
    const tools: QueueTools = {
      ...built,
      crustdata: { enrichCompany: async () => ({ data: [], status: 200, exchangeId: "" }) } as unknown as QueueTools["crustdata"],
    };
    const exec = await executeQueue({
      queue: [request],
      manifest,
      tools,
      variant: "guarded",
      gate: gctx.gate,
      humanOverride: true,
      runId: item.bundle.runId,
      policy: pinned,
      now,
    });
    const d = exec.decisions[0];
    if (!d) return { ...base, decision: "approved", ...money, effects: [], status: "failed", error: exec.stopReason ?? "the request was not processed", decidedAt: decidedAt() };
    if (d.status === "executed") return { ...base, decision: "approved", ...money, effects: d.effects, status: "executed", decidedAt: decidedAt() };
    return {
      ...base,
      decision: "approved",
      ...money,
      effects: d.effects,
      status: "failed",
      error: `${d.status}: ${d.error ?? d.evidencePack?.reason ?? "not executed"}`,
      decidedAt: decidedAt(),
    };
  } catch (err) {
    if (isBlockedError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      return { blocked: msg.startsWith("BLOCKED:") ? msg : `BLOCKED: ${msg}` };
    }
    // Unexpected crash: record it as failed so the item can't be approved (and possibly written) twice.
    return { ...base, decision: "approved", ...money, effects: [], status: "failed", error: `crashed: ${err instanceof Error ? err.message : String(err)}`, decidedAt: decidedAt() };
  } finally {
    unwire?.();
    if (ownDb) db?.close();
  }
}

/** Mount GET/POST /api/approvals (token + localhost). */
export function mountApprovals(app: Hono, opts: ApprovalsOptions & { session: ApiSession }): void {
  const guard = requireLocalSession(opts.session);
  app.get("/api/approvals", guard, async (c) => c.json(await listApprovals(opts)));
  app.post("/api/approvals", guard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const res = await decideApproval(body, opts);
    return c.json(res.body as object, res.status);
  });
}
