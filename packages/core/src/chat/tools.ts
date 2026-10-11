// Notary Chat's tools: every one READS. There is no write tool, and the two that reach external APIs
// are read-only by construction:
//   - crustdata_lookup: tools built with a wrap that lets exactly `crustdata.enrichCompany` through
//     (Crustdata's company endpoints are POST but read-only; every other op throws before I/O),
//     through the shared CreditLedger (CRUSTDATA_CREDIT_BUDGET) and refused once the turn's model
//     spend reached NOTARY_MAX_USD.
//   - dodo_lookup: the Dodo test-mode lock (NOTARY_MODE=test + the test base URL, else unavailable),
//     a wrap that lets exactly dodo.getPayment / getRefund / getSubscription through, AND a recorder
//     restricted to GET (`allowedMethods`), so a Dodo write can't leave the process even if the wrap
//     were bypassed.
// Local tools read the verified bundles serve already loads (real runs only, sample:false), their
// timelines, and — injected by server.ts so this module never imports approval/queue/certify code —
// the certificate builder, the approvals list (read side) and the health checks.
//
// A tool whose service isn't configured returns status "unavailable" with fix
// "Not connected — set <VAR> in .env", and its model text tells the model it could not check. Every
// result carries `citables`: the record ids (certificate, run, run event, approval, doc URL, or the
// step itself as an API response) a citation may name, validated later against these outputs only.
import { z } from "zod";
import { SAFE_RUN_ID } from "../api/bundle-source.js";
import type { LoadedBundle } from "../api/bundle-source.js";
import { timelineFor } from "../api/ask-world.js";
import { timelineEventId } from "../explain/citations.js";
import type { CertificatesResponse, HealthResponse } from "../schema/api.js";
import type { ApprovalsList } from "../schema/approval.js";
import type { Certificate, NoCertificate, Revocation } from "../schema/certificate.js";
import type { ChatCitationType, ChatStepStatus, ChatToolName } from "../schema/chat.js";
import type { RunBundle } from "../schema/index.js";
import type { TimelineEvent } from "../schema/timeline.js";
import { CreditLedger, DODO_TEST_BASE_URL, assertTestMode, createTools, isBlocked } from "../tools/index.js";
import type { CreateToolsOptions, Tools, Wrap } from "../tools/index.js";
import { fetchDoc } from "./docs.js";
import type { DocResult } from "./docs.js";

type Env = Record<string, string | undefined>;

/** Max characters of a tool result shown to the model. */
export const TOOL_TEXT_CHARS = 6000;
/** Characters of a fetched page shown on the doc card. */
export const DOC_PASSAGE_CHARS = 1500;
/** Max characters of a step's structured `data` (JSON) sent to the UI. */
export const TOOL_DATA_CHARS = 8000;
/** Crustdata enrich fields chat asks for (2 credits per record at list price). */
export const CHAT_CRUSTDATA_FIELDS = ["basic_info", "headcount", "funding"] as const;
/** The only tool-client ops Notary Chat can reach. All reads. */
export const CHAT_READ_OPS = ["crustdata.enrichCompany", "dodo.getPayment", "dodo.getRefund", "dodo.getSubscription"] as const;

export interface Citable {
  type: ChatCitationType;
  id: string;
  label: string;
  url?: string;
}

export interface ToolRun {
  status: Exclude<ChatStepStatus, "aborted">;
  /** One-line summary for step_finished.output. */
  output: string;
  /** Structured result for the UI card (size-capped by the caller). */
  data?: unknown;
  /** What the model sees. */
  modelText: string;
  credits?: number;
  fix?: string;
  citables: Citable[];
}

export interface ChatSources {
  /** Certificates derived from the real runs (server.ts: realCertificates). */
  certificates?: () => Promise<CertificatesResponse>;
  /** The approvals desk's read side (server.ts: listApprovals). */
  approvals?: () => Promise<ApprovalsList>;
  /** GET /api/health's checks (server.ts: the shared Health instance). */
  health?: () => Promise<HealthResponse>;
}

export interface ToolContext extends ChatSources {
  env: Env;
  signal: AbortSignal;
  /** Verified bundles from serve's bundle directories. */
  loadBundles: () => Promise<LoadedBundle[]>;
  runsDir: string | null;
  /** fetch_doc transport (default global fetch). */
  fetch?: typeof fetch;
  /** Per-conversation fetch_doc cache (url -> result). */
  docCache: Map<string, DocResult>;
  /** Crustdata credit ledger shared by every chat in this server (CRUSTDATA_CREDIT_BUDGET). */
  ledger: CreditLedger;
  /** The turn's model spend so far and NOTARY_MAX_USD (null: no cap). */
  usdSpent: () => number;
  maxUsd: number | null;
  /** Test seam: build the tool clients (default createTools). */
  makeTools?: (opts: CreateToolsOptions) => Tools;
}

export interface ChatToolDef {
  name: ChatToolName;
  description: string;
  /** Args as shown to the model. */
  argsDoc: string;
  args: z.ZodType<Record<string, unknown>>;
  title: (args: Record<string, unknown>) => string;
  input: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolRun>;
}

// ------------------------------------------------------------------------------------- helpers

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function oneLine(s: string, max = 200): string {
  return clip(s.replace(/\s+/g, " ").trim(), max);
}

function json(x: unknown): string {
  return JSON.stringify(x);
}

/** Fix line for a missing variable (the exact shape the UI shows). */
export function notConnected(variable: string): string {
  return `Not connected — set ${variable} in .env`;
}

function unavailable(output: string, fix: string, modelWhy: string): ToolRun {
  return {
    status: "unavailable",
    output,
    fix,
    modelText: `UNAVAILABLE: ${modelWhy} You could not check this. Tell the user plainly that it could not be checked and why; do not guess or invent data.`,
    citables: [],
  };
}

function failed(output: string, detail: string, fix?: string): ToolRun {
  return {
    status: "error",
    output: oneLine(output),
    ...(fix ? { fix } : {}),
    modelText: `ERROR: ${detail} Nothing was learned from this step; do not guess what it would have returned.`,
    citables: [],
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function realBundles(loaded: readonly LoadedBundle[]): LoadedBundle[] {
  return loaded.filter((l) => !l.bundle.sample);
}

/** A wrap that lets exactly `allowed` ops through and refuses every other op before any I/O. */
export function chatReadOnlyWrap(allowed: readonly string[]): Wrap {
  return ((op: string, fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      if (!allowed.includes(op)) throw new Error(`notary chat: ${op} is not allowed (chat is read-only)`);
      return await fn(...args);
    }) as Wrap;
}

/** Reject as soon as `signal` fires (the underlying request is cancelled through the same signal). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// ------------------------------------------------------------------------------- certificates

type CertLike = { kind: "certificate"; cert: Certificate } | { kind: "revocation"; rev: Revocation };

function certSummary(c: Certificate): Record<string, unknown> {
  return {
    id: c.id,
    status: c.status,
    tool: c.tool,
    claimId: c.claimId,
    operation: c.claim.operation,
    param: c.claim.param,
    side: c.side,
    verdict: c.verdict,
    confidence: c.confidence,
    scope: c.scope.text,
    issuedAt: c.issuedAt,
    sourceRun: c.sourceBundle.runId,
  };
}

function revSummary(r: Revocation): Record<string, unknown> {
  return { id: r.id, certificateId: r.certificateId, tool: r.tool, claimId: r.claimId, revokedAt: r.revokedAt, to: r.to, reason: oneLine(r.reason, 300), sourceRun: r.sourceBundle.runId };
}

function words(q: string): string[] {
  return q.toLowerCase().match(/[a-z0-9][a-z0-9_.:-]*/g) ?? [];
}

const searchCertificates: ChatToolDef = {
  name: "search_certificates",
  description: "Search the certificates (and revocations, and claims with no certificate) Notary issued from real runs. Empty query lists them all.",
  argsDoc: '{"query": "<words: tool, claim id, operation, param or status; may be empty>"}',
  args: z.object({ query: z.string().max(200).default("") }).strict(),
  title: (a) => (String(a.query ?? "").trim() ? `Searching certificates for "${oneLine(String(a.query), 60)}"` : "Listing certificates"),
  input: (a) => oneLine(String(a.query ?? ""), 120),
  async run(a, ctx) {
    if (!ctx.certificates) return unavailable("Certificates are not available in this server", "Restart `pnpm notary serve`", "The certificate source is not wired into this server.");
    const res = await ctx.certificates();
    const terms = words(String(a.query ?? ""));
    const all: CertLike[] = res.tools.flatMap((t) => [
      ...t.certificates.map((cert) => ({ kind: "certificate" as const, cert })),
      ...t.revocations.map((rev) => ({ kind: "revocation" as const, rev })),
    ]);
    const hay = (x: CertLike) => json(x.kind === "certificate" ? certSummary(x.cert) : revSummary(x.rev)).toLowerCase();
    const scored = all
      .map((x) => ({ x, score: terms.reduce((n, t) => n + (hay(x).includes(t) ? 1 : 0), 0) }))
      .filter((s) => terms.length === 0 || s.score > 0)
      .sort((p, q) => q.score - p.score);
    const top = scored.slice(0, 12).map((s) => s.x);
    const none: NoCertificate[] = res.tools.flatMap((t) => t.noCertificates).filter((n) => terms.length === 0 || terms.some((t) => json(n).toLowerCase().includes(t)));
    const certItems = top.map((x) => (x.kind === "certificate" ? { kind: "certificate", ...certSummary(x.cert) } : { kind: "revocation", ...revSummary(x.rev) }));
    const noneItems = none.slice(0, 12).map((n) => ({ tool: n.tool, claimId: n.claimId, status: n.status, kind: n.kind, reason: oneLine(n.reason, 200) }));
    const totalCerts = res.tools.reduce((n, t) => n + t.certificates.length, 0);
    const output = `${top.length} matching certificate/revocation record(s) of ${totalCerts} certificate(s) from real runs; ${none.length} claim(s) without a certificate matched`;
    return {
      status: "ok",
      output,
      data: { world: res.world, matches: certItems, noCertificate: noneItems },
      modelText: `${output}.\nMatches: ${json(certItems)}\nClaims with no certificate (not citable as certificates): ${json(noneItems)}`,
      citables: top.map((x) =>
        x.kind === "certificate"
          ? { type: "certificate" as const, id: x.cert.id, label: `Certificate ${x.cert.id} (${x.cert.tool} ${x.cert.claimId})` }
          : { type: "certificate" as const, id: x.rev.id, label: `Revocation ${x.rev.id} of ${x.rev.certificateId}` },
      ),
    };
  },
};

const getCertificate: ChatToolDef = {
  name: "get_certificate",
  description: "One certificate or revocation by id: claim, docs vs observed, scope, evidence (probe ids, trace ids), the experiments behind it, the Adversary review.",
  argsDoc: '{"id": "cert-<16 hex> or rev-<16 hex>"}',
  args: z.object({ id: z.string().regex(/^(cert|rev)-[0-9a-f]{16}$/, "id must be cert-<16 hex> or rev-<16 hex>") }).strict(),
  title: (a) => `Opening certificate ${String(a.id)}`,
  input: (a) => String(a.id),
  async run(a, ctx) {
    if (!ctx.certificates) return unavailable("Certificates are not available in this server", "Restart `pnpm notary serve`", "The certificate source is not wired into this server.");
    const id = String(a.id);
    const res = await ctx.certificates();
    for (const t of res.tools) {
      const c = t.certificates.find((x) => x.id === id);
      if (c) {
        const detail = {
          ...certSummary(c),
          docsSay: c.docsSay,
          observed: c.observed,
          docUrl: c.docUrl,
          verdictKind: c.verdictKind,
          defectClass: c.defectClass,
          scope: c.scope,
          evidenceCount: c.evidence.length,
          evidence: c.evidence.map((e) => ({ probeId: e.probeId, traceId: e.traceId, template: e.template, verdict: e.verdict, valid: e.valid, observed: e.observed })),
          adversary: c.adversary ? { verdict: c.adversary.verdict, reason: oneLine(c.adversary.reason, 400), model: c.adversary.model } : null,
          revocation: c.revocation ?? null,
          alpha: c.alpha,
          beta: c.beta,
        };
        return {
          status: "ok",
          output: `${c.id}: ${c.tool} ${c.claimId} — ${c.status}, ${c.verdict} (confidence ${c.confidence.toFixed(2)}, ${c.evidence.length} evidence probe(s))`,
          data: detail,
          modelText: json(detail),
          citables: [
            { type: "certificate", id: c.id, label: `Certificate ${c.id} (${c.tool} ${c.claimId})` },
            { type: "run", id: c.sourceBundle.runId, label: `Run ${c.sourceBundle.runId}` },
          ],
        };
      }
      const r = t.revocations.find((x) => x.id === id);
      if (r) {
        const detail = { ...revSummary(r), reason: r.reason, triggerProbeIds: r.triggerProbeIds, triggerTraceIds: r.triggerTraceIds, guardsRetired: r.guardsRetired, confidence: r.confidence };
        return {
          status: "ok",
          output: `${r.id}: revoked ${r.certificateId} (${r.tool} ${r.claimId}) at ${r.revokedAt}`,
          data: detail,
          modelText: json(detail),
          citables: [
            { type: "certificate", id: r.id, label: `Revocation ${r.id}` },
            { type: "run", id: r.sourceBundle.runId, label: `Run ${r.sourceBundle.runId}` },
          ],
        };
      }
    }
    return { status: "ok", output: `No certificate or revocation ${id} in the real runs`, data: { found: false, id }, modelText: `No certificate or revocation with id ${id} exists in the real runs this server sees.`, citables: [] };
  },
};

// --------------------------------------------------------------------------------------- runs

function runEntry(b: RunBundle): Record<string, unknown> {
  return { runId: b.runId, kind: b.kind, variant: b.variant, mode: b.mode, status: b.status, tool: b.tool, startedAt: b.startedAt, finishedAt: b.finishedAt };
}

function countBy<T>(xs: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

const listRuns: ChatToolDef = {
  name: "list_runs",
  description: "The real runs this server has (hash-verified bundles, sample/fixture data excluded), oldest first.",
  argsDoc: "{}",
  args: z.object({}).strict(),
  title: () => "Listing real runs",
  input: () => "",
  async run(_a, ctx) {
    const runs = realBundles(await ctx.loadBundles())
      .map((l) => l.bundle)
      .sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt) || (x.runId < y.runId ? -1 : 1));
    const items = runs.map(runEntry);
    const output = runs.length === 0 ? "No real runs yet (only sample/fixture data, which chat does not use)" : `${runs.length} real run(s)`;
    return {
      status: "ok",
      output,
      data: { runs: items.slice(-50) },
      modelText: `${output}.\n${json(items.slice(-50))}`,
      citables: runs.map((b) => ({ type: "run" as const, id: b.runId, label: `Run ${b.runId}` })),
    };
  },
};

const getRun: ChatToolDef = {
  name: "get_run",
  description: "Summary of one real run: status, metrics, decisions by status, probes, beliefs, guards, credits and model spend.",
  argsDoc: '{"id": "<runId>"}',
  args: z.object({ id: z.string().regex(SAFE_RUN_ID, "not a valid run id") }).strict(),
  title: (a) => `Opening run ${String(a.id)}`,
  input: (a) => String(a.id),
  async run(a, ctx) {
    const id = String(a.id);
    const loaded = realBundles(await ctx.loadBundles()).find((l) => l.bundle.runId === id);
    if (!loaded) return { status: "ok", output: `No real run ${id}`, data: { found: false, id }, modelText: `No real run with id ${id} exists on this server (sample/fixture runs are not used).`, citables: [] };
    const b = loaded.bundle;
    const events = timelineFor(loaded, ctx.runsDir);
    const usd = Math.round((b.usageByRole.executor.usd + b.usageByRole.reflector.usd + b.usageByRole.adversary.usd) * 1e6) / 1e6;
    const summary = {
      ...runEntry(b),
      stopReason: b.stopReason,
      disclosure: b.disclosure,
      metrics: b.metrics,
      queueRequests: b.queue.length,
      decisionsByStatus: countBy(b.decisions, (d) => d.status),
      heldDecisions: b.decisions.filter((d) => d.status === "held").map((d) => ({ id: d.id, action: d.action, missingBeliefs: d.missingBeliefs })).slice(0, 20),
      probes: b.probes.length,
      anomalies: b.anomalies.length,
      beliefsByStatus: countBy(b.beliefs.after, (x) => x.status),
      guards: b.guards.length,
      credits: b.credits,
      modelUsd: usd,
      timelineEvents: events.length,
    };
    return {
      status: "ok",
      output: `${b.runId}: ${b.kind}/${b.variant} ${b.status}, ${b.decisions.length} decision(s), ${b.probes.length} probe(s), ${events.length} timeline event(s)`,
      data: summary,
      modelText: json(summary),
      citables: [{ type: "run", id: b.runId, label: `Run ${b.runId}` }],
    };
  },
};

const RUN_EVENTS_MAX = 25;

const getRunEvents: ChatToolDef = {
  name: "get_run_events",
  description: `Timeline events of one real run (what happened, in order). Optional filter: an event type (e.g. decision, probe.verdict, certificate.issued), a stage (read/test/challenge/certify/enforce) or words in the summary/record ids. Returns at most ${RUN_EVENTS_MAX}.`,
  argsDoc: '{"runId": "<runId>", "filter": "<optional type, stage or words>"}',
  args: z.object({ runId: z.string().regex(SAFE_RUN_ID, "not a valid run id"), filter: z.string().max(200).optional() }).strict(),
  title: (a) => `Reading the timeline of ${String(a.runId)}${a.filter ? ` (${oneLine(String(a.filter), 40)})` : ""}`,
  input: (a) => `${String(a.runId)}${a.filter ? ` · ${oneLine(String(a.filter), 80)}` : ""}`,
  async run(a, ctx) {
    const runId = String(a.runId);
    const loaded = realBundles(await ctx.loadBundles()).find((l) => l.bundle.runId === runId);
    if (!loaded) return { status: "ok", output: `No real run ${runId}`, data: { found: false, runId }, modelText: `No real run with id ${runId} exists on this server.`, citables: [] };
    const events = timelineFor(loaded, ctx.runsDir);
    const f = String(a.filter ?? "").trim().toLowerCase();
    const terms = words(f);
    const match = (e: TimelineEvent) =>
      !f || e.type === f || e.stage === f || terms.every((t) => `${e.type} ${e.stage} ${e.summary} ${e.recordIds.join(" ")}`.toLowerCase().includes(t));
    const hits = events.filter(match);
    const shown = hits.slice(0, RUN_EVENTS_MAX);
    const items = shown.map((e) => ({ id: timelineEventId(runId, e.seq), runId, seq: e.seq, at: e.at, stage: e.stage, type: e.type, summary: e.summary, recordIds: e.recordIds.slice(0, 6) }));
    const output = `${hits.length} of ${events.length} event(s) in ${runId}${f ? ` match "${oneLine(f, 40)}"` : ""}${hits.length > shown.length ? `; first ${shown.length} shown` : ""}`;
    return {
      status: "ok",
      output,
      data: { runId, total: events.length, matched: hits.length, events: items },
      modelText: `${output}.\n${json(items)}`,
      citables: shown.map((e) => ({ type: "run_event" as const, id: timelineEventId(runId, e.seq), label: `${runId} event #${e.seq} (${e.type})` })),
    };
  },
};

// ---------------------------------------------------------------------------------- approvals

const listApprovalsTool: ChatToolDef = {
  name: "list_approvals",
  description: "Held actions waiting for a human on the Approvals card (with their evidence: reason, missing beliefs, amount) and past decisions. Read-only: chat cannot approve or reject.",
  argsDoc: "{}",
  args: z.object({}).strict(),
  title: () => "Checking held actions on the Approvals card",
  input: () => "",
  async run(_a, ctx) {
    if (!ctx.approvals) return unavailable("Approvals are not available in this server", "Restart `pnpm notary serve`", "The approvals source is not wired into this server.");
    const list = await ctx.approvals();
    const pending = list.pending.map((p) => ({ id: p.id, runId: p.runId, decisionId: p.decisionId, action: p.action, amount: p.amount, currency: p.currency, reason: oneLine(p.reason, 300), missingBeliefs: p.missingBeliefs }));
    const decided = list.decided.map((d) => ({ id: d.id, runId: d.runId, action: d.action, decision: d.decision, status: d.status, decidedAt: d.decidedAt }));
    const output = `${pending.length} held action(s) waiting, ${decided.length} decided; Dodo test mode ${list.testMode ? "on" : "off"}`;
    return {
      status: "ok",
      output,
      data: { testMode: list.testMode, pending, decided: decided.slice(-20) },
      modelText: `${output}. Approve/reject happens only on the Approvals card (/app/approvals).\nPending: ${json(pending)}\nDecided: ${json(decided.slice(-20))}`,
      citables: [
        ...pending.filter((p) => p.id).map((p) => ({ type: "approval" as const, id: p.id!, label: `Held ${p.action} (${p.id})` })),
        ...decided.map((d) => ({ type: "approval" as const, id: d.id, label: `${d.decision} ${d.action} (${d.id})` })),
      ],
    };
  },
};

const getApproval: ChatToolDef = {
  name: "get_approval",
  description: "One held action or approval record by id (appr-<16 hex>), with its evidence pack.",
  argsDoc: '{"id": "appr-<16 hex>"}',
  args: z.object({ id: z.string().regex(/^appr-[0-9a-f]{16}$/, "id must be appr-<16 hex>") }).strict(),
  title: (a) => `Opening approval ${String(a.id)}`,
  input: (a) => String(a.id),
  async run(a, ctx) {
    if (!ctx.approvals) return unavailable("Approvals are not available in this server", "Restart `pnpm notary serve`", "The approvals source is not wired into this server.");
    const id = String(a.id);
    const list = await ctx.approvals();
    const p = list.pending.find((x) => x.id === id);
    if (p) {
      const detail = { state: "held (waiting for a human on /app/approvals)", ...p, testMode: list.testMode };
      return {
        status: "ok",
        output: `${id}: held ${p.action}${p.amount === undefined ? "" : ` for ${p.amount} ${p.currency ?? ""} (minor units)`} — ${oneLine(p.reason, 100)}`,
        data: detail,
        modelText: json(detail),
        citables: [
          { type: "approval", id, label: `Held ${p.action} (${id})` },
          { type: "run", id: p.runId, label: `Run ${p.runId}` },
        ],
      };
    }
    const d = list.decided.find((x) => x.id === id);
    if (d) {
      const detail = { ...d, effects: d.effects.slice(0, 10) };
      return {
        status: "ok",
        output: `${id}: ${d.decision} ${d.action}, ${d.status} at ${d.decidedAt}`,
        data: detail,
        modelText: json(detail),
        citables: [
          { type: "approval", id, label: `${d.decision} ${d.action} (${id})` },
          { type: "run", id: d.runId, label: `Run ${d.runId}` },
        ],
      };
    }
    return { status: "ok", output: `No approval ${id}`, data: { found: false, id }, modelText: `No held action or approval record with id ${id} exists.`, citables: [] };
  },
};

// ------------------------------------------------------------------------------------ fetch_doc

const fetchDocTool: ChatToolDef = {
  name: "fetch_doc",
  description: "Read one documentation page (https only) from the docs Notary relies on: Crustdata, Dodo Payments, neatlogs, Entire, cfo.ai. Any other site is refused.",
  argsDoc: '{"url": "https://docs.<allowed host>/..."}',
  args: z.object({ url: z.string().min(1).max(2000) }).strict(),
  title: (a) => {
    let host = "";
    try {
      host = new URL(String(a.url)).hostname;
    } catch {
      host = "a page";
    }
    return `Reading ${host} docs`;
  },
  input: (a) => oneLine(String(a.url), 200),
  async run(a, ctx) {
    const url = String(a.url);
    const cached = ctx.docCache.get(url);
    const res = cached ?? (await fetchDoc(url, { signal: ctx.signal, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) }));
    if (!cached && res.ok) ctx.docCache.set(url, res);
    if (!res.ok) {
      if (res.kind === "refused") {
        return { ...unavailable(`Refused: ${oneLine(res.reason, 180)}`, "fetch_doc only reads the allowlisted docs sites (Crustdata, Dodo Payments, neatlogs, Entire, cfo.ai)", `fetch_doc refused ${url}: ${res.reason}.`) };
      }
      return failed(`Could not read the page: ${res.reason}`, `fetch_doc could not read ${url}: ${res.reason}.`);
    }
    const label = res.title ? `${res.title}` : res.finalUrl;
    return {
      status: "ok",
      output: `${oneLine(label, 120)} — ${res.text.length} chars${res.truncated ? " (truncated)" : ""}${cached ? " (cached)" : ""}`,
      // Doc card: { url, title, passage } — the opening of the extracted text the model was given.
      data: { url: res.url, finalUrl: res.finalUrl, title: res.title ?? res.finalUrl, passage: clip(res.text, DOC_PASSAGE_CHARS), truncated: res.truncated },
      modelText: `Page ${res.finalUrl}${res.title ? ` — "${res.title}"` : ""}${res.truncated ? " (truncated)" : ""}:\n${res.text}`,
      citables: [
        { type: "doc", id: res.url, label: oneLine(label, 120), url: res.url },
        ...(res.finalUrl !== res.url ? [{ type: "doc" as const, id: res.finalUrl, label: oneLine(label, 120), url: res.finalUrl }] : []),
      ],
    };
  },
};

// ------------------------------------------------------------------------------- crustdata / dodo

function apiCitable(stepIdPlaceholder: string, label: string): Citable {
  // The step id is filled in by the agent loop (api_response citations name the step).
  return { type: "api_response", id: stepIdPlaceholder, label };
}

/** Marker the agent loop replaces with the real step id. */
export const STEP_ID_PLACEHOLDER = "$step";

function companyQuery(raw: string): { domains: string[] } | { names: string[] } {
  const t = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(t) ? { domains: [t] } : { names: [raw.trim()] };
}

function companyFacts(data: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (!Array.isArray(data)) return out;
  for (const r of data as { matched_on?: string; matches?: { confidence_score?: number; company_data?: Record<string, any> }[] }[]) {
    for (const m of (r.matches ?? []).slice(0, 3)) {
      const c = m.company_data ?? {};
      out.push({
        matchedOn: r.matched_on,
        confidence: m.confidence_score,
        crustdataCompanyId: c.crustdata_company_id,
        name: c.basic_info?.name,
        domain: c.basic_info?.primary_domain,
        employeeRange: c.basic_info?.employee_count_range,
        headcount: c.headcount?.total ?? null,
        fundingTotalUsd: c.funding?.total_investment_usd ?? null,
        lastRound: c.funding?.last_round_type ?? null,
        lastFundraiseDate: c.funding?.last_fundraise_date ?? null,
      });
    }
  }
  return out;
}

const crustdataLookup: ChatToolDef = {
  name: "crustdata_lookup",
  description: "Live, read-only Crustdata company enrichment (basic info, headcount, funding) by domain or name. Costs Crustdata credits (counts against CRUSTDATA_CREDIT_BUDGET).",
  argsDoc: '{"company": "<domain like acme.com, or a company name>"}',
  args: z.object({ company: z.string().trim().min(1).max(200) }).strict(),
  title: (a) => `Looking up ${oneLine(String(a.company), 60)} in Crustdata`,
  input: (a) => oneLine(String(a.company), 120),
  async run(a, ctx) {
    if (!(ctx.env.CRUSTDATA_API_KEY ?? "").trim()) return unavailable("Crustdata is not connected", notConnected("CRUSTDATA_API_KEY"), "Crustdata is not connected (CRUSTDATA_API_KEY is not set).");
    if (ctx.maxUsd !== null && ctx.usdSpent() >= ctx.maxUsd) {
      return failed(`Stopped: this turn reached NOTARY_MAX_USD ($${ctx.maxUsd})`, `The turn reached the NOTARY_MAX_USD cap ($${ctx.maxUsd}); no Crustdata call was made.`, "Raise NOTARY_MAX_USD in .env (or unset it), then restart `pnpm notary serve`");
    }
    const before = ctx.ledger.total;
    const base = {
      mode: "live" as const,
      // The bundle always constructs the Dodo client (test-mode lock in its constructor); this tool never
      // reaches Dodo (the wrap refuses every Dodo op), so the Dodo side is pinned to test mode like the health probe.
      env: { ...ctx.env, NOTARY_MODE: "test" } as NodeJS.ProcessEnv,
      dodoBaseUrl: DODO_TEST_BASE_URL,
      ledger: ctx.ledger,
      signal: ctx.signal,
      timeoutMs: 20_000,
    };
    // A direct createTools() call with a literal read-only wrap, so `notary guards coverage` sees it.
    const tools = ctx.makeTools
      ? ctx.makeTools({ ...base, wrap: chatReadOnlyWrap(["crustdata.enrichCompany"]) })
      : createTools({ ...base, wrap: chatReadOnlyWrap(["crustdata.enrichCompany"]) });
    const query = companyQuery(String(a.company));
    try {
      const res = await abortable(tools.crustdata.enrichCompany({ ...query, fields: [...CHAT_CRUSTDATA_FIELDS] }), ctx.signal);
      const credits = Math.round((ctx.ledger.total - before) * 1e6) / 1e6;
      const facts = companyFacts(res.data);
      const output = facts.length ? `${facts.length} match(es); top: ${String(facts[0]!.name ?? facts[0]!.domain ?? "unnamed")} — ${credits} credit(s) used` : `No company matched — ${credits} credit(s) used`;
      return {
        status: "ok",
        output,
        credits,
        data: { query, matches: facts, credits, ledger: { used: ctx.ledger.total, budget: ctx.ledger.budget } },
        modelText: `Crustdata POST /company/enrich (read) for ${json(query)} → HTTP ${res.status}; ${credits} credit(s) used.\n${json(facts)}`,
        citables: [apiCitable(STEP_ID_PLACEHOLDER, `Crustdata enrich ${"domains" in query ? query.domains[0] : query.names[0]}`)],
      };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      const credits = Math.round((ctx.ledger.total - before) * 1e6) / 1e6;
      const run = failed(`Crustdata lookup failed: ${errText(err)}`, `Crustdata returned an error: ${oneLine(errText(err), 300)}.`, isBlocked(err)
          ? "Check CRUSTDATA_API_KEY in .env, then restart `pnpm notary serve`"
          : err instanceof Error && err.name === "BudgetExceededError"
            ? `Raise CRUSTDATA_CREDIT_BUDGET in .env (budget ${ctx.ledger.budget} credits, ${ctx.ledger.total} used by chat in this server), then restart \`pnpm notary serve\``
            : undefined);
      return { ...run, credits };
    }
  },
};

const DODO_KINDS = { payments: "getPayment", refunds: "getRefund", subscriptions: "getSubscription" } as const;

const dodoLookup: ChatToolDef = {
  name: "dodo_lookup",
  description: "Live, read-only Dodo Payments lookup in TEST mode: one payment, refund or subscription by id (GET only; chat can never create, refund or change anything).",
  argsDoc: '{"kind": "payments" | "refunds" | "subscriptions", "id": "<Dodo id, e.g. pay_...>"}',
  args: z.object({ kind: z.enum(["payments", "refunds", "subscriptions"]), id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "not a valid Dodo id") }).strict(),
  title: (a) => `Reading ${String(a.kind).replace(/s$/, "")} ${String(a.id)} from Dodo (test mode)`,
  input: (a) => `${String(a.kind)} ${String(a.id)}`,
  async run(a, ctx) {
    if (!(ctx.env.DODO_PAYMENTS_API_KEY ?? "").trim()) return unavailable("Dodo Payments is not connected", notConnected("DODO_PAYMENTS_API_KEY"), "Dodo Payments is not connected (DODO_PAYMENTS_API_KEY is not set).");
    try {
      assertTestMode("live", ctx.env.DODO_BASE_URL?.trim() || DODO_TEST_BASE_URL, ctx.env as NodeJS.ProcessEnv);
    } catch (err) {
      return unavailable(
        "Dodo test-mode lock is off",
        `Set NOTARY_MODE=test and DODO_BASE_URL=${DODO_TEST_BASE_URL} in .env (chat reads Dodo in test mode only)`,
        `The Dodo test-mode lock is off (${oneLine(errText(err), 160)}), and chat only reads Dodo in test mode.`,
      );
    }
    const kind = a.kind as keyof typeof DODO_KINDS;
    const method = DODO_KINDS[kind];
    const base = {
      mode: "live" as const,
      env: ctx.env as NodeJS.ProcessEnv,
      // GET only at the recorder: a Dodo write can't leave the process even if the wrap were bypassed.
      allowedMethods: ["GET"],
      ledger: new CreditLedger({ budget: 0 }),
      signal: ctx.signal,
      timeoutMs: 15_000,
    };
    const tools = ctx.makeTools
      ? ctx.makeTools({ ...base, wrap: chatReadOnlyWrap([`dodo.${method}`]) })
      : createTools({ ...base, wrap: chatReadOnlyWrap([`dodo.${method}`]) });
    const id = String(a.id);
    try {
      const res = await abortable((tools.dodo[method] as (id: string) => Promise<{ data: unknown; status: number }>)(id), ctx.signal);
      const body = res.data as Record<string, unknown>;
      const brief: Record<string, unknown> = {};
      for (const k of ["payment_id", "refund_id", "subscription_id", "status", "total_amount", "amount", "currency", "created_at", "reason", "product_id", "next_billing_date", "recurring_pre_tax_amount", "customer"]) {
        if (body && k in body) brief[k] = k === "customer" && body[k] && typeof body[k] === "object" ? { customer_id: (body[k] as Record<string, unknown>).customer_id } : body[k];
      }
      return {
        status: "ok",
        output: `${kind.replace(/s$/, "")} ${id}: ${String(body?.status ?? "no status")} (test mode)`,
        data: { kind, id, testMode: true, fields: brief },
        modelText: `Dodo GET /${kind}/${id} (test mode) → HTTP ${res.status}.\n${clip(json(body), TOOL_TEXT_CHARS - 200)}`,
        citables: [apiCitable(STEP_ID_PLACEHOLDER, `Dodo ${kind.replace(/s$/, "")} ${id} (test mode)`)],
      };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return failed(`Dodo lookup failed: ${errText(err)}`, `Dodo returned an error for ${kind} ${id}: ${oneLine(errText(err), 300)}.`);
    }
  },
};

// ---------------------------------------------------------------------------------------- health

const getHealth: ChatToolDef = {
  name: "get_health",
  description: "Which integrations this server is connected to (the model provider, Crustdata, Dodo, neatlogs, Entire), with the exact fix for anything missing.",
  argsDoc: "{}",
  args: z.object({}).strict(),
  title: () => "Checking connections",
  input: () => "",
  async run(_a, ctx) {
    if (!ctx.health) return unavailable("Health checks are not available in this server", "Restart `pnpm notary serve`", "The health checks are not wired into this server.");
    const h = await ctx.health();
    const items = h.integrations.map((i) => ({ name: i.name, state: i.state, label: i.label, fix: i.fix }));
    return {
      status: "ok",
      output: items.map((i) => `${i.name}: ${i.label}`).join(" · "),
      data: { integrations: items },
      modelText: json(items),
      citables: [apiCitable(STEP_ID_PLACEHOLDER, "Connections (GET /api/health)")],
    };
  },
};

export const CHAT_TOOLS: readonly ChatToolDef[] = [
  searchCertificates,
  getCertificate,
  listRuns,
  getRun,
  getRunEvents,
  listApprovalsTool,
  getApproval,
  fetchDocTool,
  crustdataLookup,
  dodoLookup,
  getHealth,
];

export function toolByName(name: string): ChatToolDef | undefined {
  return CHAT_TOOLS.find((t) => t.name === name);
}

/** Cap a step's structured data for the UI (JSON size), keeping it valid JSON. */
export function capData(data: unknown): unknown {
  if (data === undefined) return undefined;
  const s = JSON.stringify(data);
  if (s === undefined) return undefined;
  if (s.length <= TOOL_DATA_CHARS) return data;
  return { truncated: true, preview: s.slice(0, TOOL_DATA_CHARS - 100) };
}
