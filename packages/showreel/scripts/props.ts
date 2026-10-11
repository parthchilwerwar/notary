// Writes src/data.json — every value the showreel puts on screen — from the published records in
// packages/web/public (the same files the landing replays). Nothing here is typed in by hand:
//
//   1. Bundles: schema-checked with core's RunBundleSchema, content hash recomputed with core's
//      bundle/hash.ts and compared with the bundle and its index entry.
//   2. Timelines: schema-checked and tied to their verified bundle's content hash.
//   3. Certificates: the fixture scenario of the chosen runs; report schema-checked, each tool file
//      pinned by the report's sha256, every certificate seal recomputed.
//   4. The views (prediction vs observation, challenge, certificate, Guard rows, chart counts)
//      follow packages/web/src/landing-data.ts line for line, so the film shows what the landing shows.
//   5. The chat turn is one turn of the web's deterministic replay chat engine (no model) over
//      those same files, read from disk.
//
// Data-derived text passes the landing's `showable` filter (no run ids or environment words).
// Any failed check throws: no data.json is written and the render has nothing to show.
//
//   pnpm --filter @notary/showreel props
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BundleIndexSchema,
  CertificateReportSchema,
  FixtureIndexSchema,
  RequestTypeSchema,
  RunBundleSchema,
  TimelineFileSchema,
  ToolCertificatesSchema,
  type BundleIndexEntry,
  type Certificate,
  type ChatEvent,
  type Decision,
  type RunBundle,
  type TimelineFile,
  type ToolCertificates,
} from "../../core/src/schema/index.js";
import { canonicalJson, computeContentHash, sha256Hex } from "../../core/src/bundle/hash.js";
import { PublishedFiles } from "../../web/src/data/published.js";
import { ReplaySource } from "../../web/src/data/replay.js";
import { ReplayChat } from "../../web/src/data/chat-replay.js";
import { memoryChatStore } from "../../web/src/data/chat-store.js";
import { budgetView, buildRows, heldCard, stageProgress, unsafeDecisionIds, type RunRow } from "../../web/src/pages/run/model.js";
import { ShowreelDataSchema, type ShowreelData } from "../src/data-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, "../../web/public");
const OUT = resolve(here, "../src/data.json");

const readJsonFile = async (rel: string): Promise<unknown> => JSON.parse(await readFile(join(PUBLIC, rel), "utf8"));

// ------------------------------------------------------------------------------- verification

function verifyBundle(raw: unknown, entry: BundleIndexEntry): RunBundle {
  const parsed = RunBundleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${entry.runId}: bundle fails the shared schema`);
  const bundle = parsed.data;
  const actual = computeContentHash(bundle);
  if (actual !== bundle.contentHash) throw new Error(`${entry.runId}: content hash mismatch (recorded ${bundle.contentHash}, computed ${actual})`);
  if (entry.contentHash !== bundle.contentHash || entry.runId !== bundle.runId || entry.sample !== bundle.sample)
    throw new Error(`${entry.runId}: bundle disagrees with its index entry`);
  return bundle;
}

function verifyTimeline(raw: unknown, bundle: RunBundle): TimelineFile {
  const parsed = TimelineFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${bundle.runId}: timeline fails the shared schema`);
  const file = parsed.data;
  if (file.runId !== bundle.runId || file.sample !== bundle.sample || file.bundleHash !== bundle.contentHash)
    throw new Error(`${bundle.runId}: timeline is not tied to the verified bundle`);
  return file;
}

const sealOf = (record: { sha256: string }) => {
  const { sha256: _ignored, ...rest } = record;
  return sha256Hex(canonicalJson(rest));
};

function verifyToolFile(raw: unknown, pinned: string | undefined, sample: boolean, file: string): ToolCertificates {
  const parsed = ToolCertificatesSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: fails the shared certificate schema`);
  if (!pinned || sha256Hex(canonicalJson(raw)) !== pinned) throw new Error(`${file}: does not match the hash pinned in its report`);
  if (parsed.data.sample !== sample) throw new Error(`${file}: mixes data worlds`);
  for (const record of [...parsed.data.certificates, ...parsed.data.revocations]) {
    if (sealOf(record) !== record.sha256) throw new Error(`${file}: seal mismatch for ${record.id}`);
    if (record.sample !== sample) throw new Error(`${file}: ${record.id} mixes data worlds`);
  }
  return parsed.data;
}

// ------------------------------------------------------------------------------- landing rules
// Mirrors packages/web/src/landing-data.ts (web code the composition may not depend on).

const BANNED_RE = /demo|fixture|replay|recorded|mock|sample|simulated|test[\s-]+mode|placeholder|hackathon/i;
const showable = (text: string) => !BANNED_RE.test(text);
const words = (s: string) => s.replaceAll("_", " ");
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortIds = (text: string) => text.replace(/\b[\w.-]*-(p\d{3,})\b/g, "$1");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const scenarioKey = (runId: string) => runId.replace(/-(run|notarize)-[a-z]+$/, "");
const REFUND_TYPES = new Set(RequestTypeSchema.options.filter((t) => t.includes("refund")));
const isRefund = (d: Pick<Decision, "requestType">) => REFUND_TYPES.has(d.requestType);
const BUILT_WITH = ["neatlogs", "Entire", "cfo.ai", "Crustdata", "Dodo Payments", "AWS Bedrock"]; // landing-data BUILT_WITH
const GITHUB = "github.com/parthchilwerwar/notary"; // web/src/lib/site.ts GITHUB_URL without the scheme

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("] "));
  const at = sentenceEnd > max * 0.5 ? sentenceEnd + 1 : cut.lastIndexOf(" ");
  return `${cut.slice(0, at > 0 ? at : max).trimEnd()}…`;
}

const money = (minor: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);

// Times in UTC, labelled, so the film renders the same everywhere.
const clockUtc = (iso: string) =>
  `${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(iso))} UTC`;
const dateUtc = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Not in the published records: ${what}`);
  return value;
}

function must(text: string, what: string): string {
  if (!showable(text)) throw new Error(`${what} carries environment words the film never shows: ${text}`);
  return text;
}

// ------------------------------------------------------------------------------- views

const classOf = (v: unknown) => (isObj(v) && typeof v.class === "string" ? v.class : undefined);
const outcomeOf = (v: unknown) => (isObj(v) && Array.isArray(v.outcomes) && typeof v.outcomes[0] === "string" ? v.outcomes[0] : undefined);

/** landing-data predictView: a probe whose committed "docs hold" prediction was contradicted. */
function predictView(bundle: RunBundle) {
  const views = bundle.probes.flatMap((p) => {
    const obs = p.observed;
    if (p.verdict !== "confirmed" || !isObj(obs) || typeof obs.outcome !== "string") return [];
    const honored = Object.entries(p.prediction).find(([, v]) => classOf(v) === "honored");
    const won = p.winningHypothesisId ? p.prediction[p.winningHypothesisId] : undefined;
    const expected = honored ? outcomeOf(honored[1]) : undefined;
    if (!expected || !won || classOf(won) === "honored" || expected === obs.outcome) return [];
    const steps = Array.isArray(p.params.steps) ? (p.params.steps as unknown[]) : [];
    const step = steps.find((x): x is Record<string, unknown> => isObj(x) && typeof x.tag === "string" && isObj(obs[x.tag]));
    const tagged = step ? (obs[step.tag as string] as Record<string, unknown>) : {};
    const fields = Object.entries(tagged).filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean");
    const args =
      step && isObj(step.params)
        ? Object.entries(step.params)
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
            .join(" ")
        : "";
    return [
      {
        probe: shortIds(p.id),
        claimId: p.claimId,
        template: words(p.template),
        committedAt: p.committedAt,
        expected: words(expected),
        call: step && typeof step.op === "string" ? { op: step.op, args } : null,
        observed: [
          ...fields.map(([k, v]) => ({ key: k === "length" ? "items" : words(k), value: String(v), mismatch: false })),
          { key: "outcome", value: words(obs.outcome), mismatch: true },
        ],
        rich: fields.length > 0 && !!step,
      },
    ];
  });
  return views.find((v) => v.rich) ?? views[0];
}

/** landing-data featuredCertificate: the active certificate with the most evidence. */
const featuredCertificate = (tools: ToolCertificates[]) =>
  tools
    .flatMap((t) => t.certificates)
    .filter((c) => c.status === "active")
    .reduce<Certificate | undefined>((best, c) => (!best || c.evidence.length > best.evidence.length ? c : best), undefined);

/** landing-data challengeView. */
function challengeView(tools: ToolCertificates[], sources: RunBundle[]) {
  const probes = new Map(sources.flatMap((b) => b.probes.map((p) => [p.id, p] as const)));
  const hyps = sources.flatMap((b) => b.hypotheses);
  const anomalies = sources.flatMap((b) => b.anomalies);
  const byReflector = (statement: string) => !/not model-proposed|^verification rival/i.test(statement);
  const reflectorHypothesis = (c: Certificate) => {
    const winners = new Set(c.evidence.map((e) => probes.get(e.probeId)?.winningHypothesisId).filter(Boolean));
    const anomalyIds = new Set(anomalies.filter((a) => a.claimId === c.claimId).map((a) => a.id));
    const forClaim = hyps.filter((h) => winners.has(h.id) || anomalyIds.has(h.anomalyId));
    const winnerClass = hyps.find((h) => winners.has(h.id))?.class;
    return (
      forClaim.find((h) => winners.has(h.id) && byReflector(h.statement)) ??
      forClaim.find((h) => h.class === winnerClass && byReflector(h.statement)) ??
      forClaim.find((h) => h.class !== "honored" && byReflector(h.statement))
    )?.statement;
  };
  const candidates = tools
    .flatMap((t) => t.certificates)
    .filter((c) => c.adversary)
    .map((c) => ({ c, hypothesis: reflectorHypothesis(c) }));
  const rank = ({ c, hypothesis }: (typeof candidates)[number]) =>
    (c.adversary!.verdict === "uphold" ? 0 : 4) + (hypothesis ? 0 : 2) + (c.verdictKind === "contradicts_docs" ? 0 : 1);
  const pick = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  const adv = pick?.c.adversary;
  if (!pick || !adv) return undefined;
  const reviews = sources.flatMap((b) => b.beliefEvents).filter((e) => e.beliefId === pick.c.beliefId && /^adversary\b/i.test(e.reason));
  const challenges = Math.max(1, reviews.length);
  return {
    claimId: pick.c.claimId,
    hypothesis: pick.hypothesis ? shortIds(pick.hypothesis) : undefined,
    counter: shortIds(adv.reason),
    verdict: adv.verdict,
    challenges,
    survived: adv.verdict === "uphold" ? challenges : 0,
  };
}

type Counts = { executed: number; held: number; unsafe: number };

/** landing-data actionsByType. */
function actionsByType(naive: RunBundle, guarded: RunBundle) {
  const count = (b: RunBundle, type: string): Counts => {
    const ds = b.decisions.filter((d) => d.requestType === type && d.action !== "none");
    return {
      executed: ds.filter((d) => d.status === "executed").length,
      held: ds.filter((d) => d.status === "held").length,
      unsafe: ds.filter((d) => d.status === "executed" && (d.grade?.unsafe?.length ?? 0) > 0).length,
    };
  };
  return RequestTypeSchema.options.map((type) => ({ type, label: sentence(words(type)), naive: count(naive, type), guarded: count(guarded, type) }));
}

/** Amounts as the run's timeline recorded them (decision events carry amount + currency). */
function recordedAmounts(timeline: TimelineFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of timeline.events) {
    if (e.type !== "decision" || !isObj(e.data)) continue;
    const { requestId, amount, currency } = e.data as Record<string, unknown>;
    if (typeof requestId === "string" && typeof amount === "number")
      out.set(requestId, money(amount, typeof currency === "string" ? currency : "USD"));
  }
  return out;
}

/** The Guard's reason as its timeline event recorded it ("— no certificate for …"). */
function recordedGuardReason(timeline: TimelineFile, requestId: string): string | undefined {
  const e = timeline.events.find((x) => x.type === "decision" && isObj(x.data) && (x.data as Record<string, unknown>).requestId === requestId);
  const m = e && /\s—\s(.+?)\.?$/.exec(e.summary);
  return m?.[1];
}

// ------------------------------------------------------------------------------- chat

/** Answer markdown → paragraphs minus the engine's "_Answering from …_" line (landing-data answerParagraphs). */
function answerParagraphs(markdown: string): string[] {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const first = blocks[0];
  const disclosure = first && /^([_*])[^_*\n]+\1$/.test(first);
  return disclosure ? blocks.slice(1) : blocks;
}

async function chatTurn(guarded: RunBundle, heldRequestId: string, tools: string[]) {
  // The web data layer over the same public/ directory, read from disk instead of over HTTP.
  const diskFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = join(PUBLIC, decodeURIComponent(url.pathname));
    try {
      return new Response(await readFile(path), { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return new Response("", { status: 404, statusText: "Not Found" });
    }
  };
  const replay = new ReplaySource({ published: new PublishedFiles({ base: "http://published.local/", fetchImpl: diskFetch }) });
  const chat = new ReplayChat(replay, { store: memoryChatStore(), pace: "instant" });
  chat.setContext({ runId: guarded.runId });
  // landing-data chatQuestions. The film wants three lookups, so among the questions whose
  // presentable part has at least two steps and a cited answer, the first with the most steps
  // (up to three) wins; ties keep the landing's order.
  const questions = [
    `Why was ${heldRequestId} held, and what changed between the naive and guarded runs?`,
    `Why was ${heldRequestId} held?`,
    ...tools.map((t) => `What do the ${t} certificates say?`),
  ];
  type Turn = {
    question: string;
    steps: { title: string; output: string; durationMs: number | null }[];
    answer: string;
    citations: { n: number; label: string }[];
    events: ChatEvent[];
  };
  let best: Turn | undefined;
  for (const question of questions) {
    const conversation = await chat.createConversation();
    const events: ChatEvent[] = [];
    await chat.sendMessage(conversation.id, question, (e) => events.push(e));
    if (events.some((e) => e.type === "error")) continue;
    const steps: { id: string; title: string; output: string; durationMs: number | null; status?: string }[] = [];
    let text = "";
    let citations: { n: number; label: string }[] = [];
    for (const e of events) {
      if (e.type === "step_started") steps.push({ id: e.id, title: e.title, output: "", durationMs: null });
      else if (e.type === "step_finished") {
        const s = steps.find((x) => x.id === e.id);
        if (s) Object.assign(s, { status: e.status, output: e.output ?? "", durationMs: e.durationMs ?? null });
      } else if (e.type === "text_delta") text += e.text;
      else if (e.type === "citations") citations = e.items.map((c) => ({ n: c.n, label: c.label }));
    }
    const shown = steps.filter((s) => s.status === "ok" && showable(s.title) && showable(s.output));
    // landing presentable(): one block per line, "- " items as "• ", only showable lines.
    const lines = answerParagraphs(text)
      .flatMap((p) => p.split("\n"))
      .map((l) => l.trim().replace(/^- /, "• "))
      .filter((l) => l && showable(l));
    const first = lines.findIndex((l) => /\[\d+\]/.test(l));
    if (shown.length < 2 || first < 0) continue;
    // The first cited line, and the next line too when it is cited as well.
    const answerLines = [lines[first]!, ...(lines[first + 1] && /\[\d+\]/.test(lines[first + 1]!) ? [lines[first + 1]!] : [])];
    const answer = answerLines.join("\n");
    const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    // The same lines in the engine's own markdown ("- " items), for the chat's real Markdown view.
    const rawLines = answerParagraphs(text)
      .flatMap((p) => p.split("\n"))
      .map((l) => l.trim())
      .filter((l) => l && showable(l));
    const markdown = rawLines.slice(first, first + answerLines.length).join("\n");
    const kept = new Set(shown.slice(0, 3).map((s) => s.id));
    const turn: Turn = {
      question,
      steps: shown.slice(0, 3).map(({ title, output, durationMs }) => ({ title, output: clipText(output.split("\n")[0] ?? "", 90), durationMs })),
      answer,
      citations: citations.filter((c) => used.has(c.n) && showable(c.label)),
      // The turn's own events, kept to what the film shows: the presentable steps (their data
      // payloads are never expanded on screen, so not carried), the answer lines above, their
      // citations, and done.
      events: [
        ...events.flatMap((e): ChatEvent[] => {
          if (e.type === "step_started") return kept.has(e.id) ? [e] : [];
          if (e.type === "step_finished") {
            if (!kept.has(e.id)) return [];
            const { data: _data, ...rest } = e;
            return [rest];
          }
          return [];
        }),
        { type: "text_delta", text: markdown },
        ...events.flatMap((e): ChatEvent[] => (e.type === "citations" ? [{ ...e, items: e.items.filter((c) => used.has(c.n) && showable(c.label)) }] : [])),
        ...events.filter((e) => e.type === "done"),
      ],
    };
    if (!best || turn.steps.length > best.steps.length) best = turn;
    if (best.steps.length >= 3) break;
  }
  if (best) return best;
  throw new Error("The replay chat engine gave no presentable answer for the guarded run");
}

// ------------------------------------------------------------------------------- dashboard
// The Run page's own builders (packages/web/src/pages/run/model.ts): transcript rows, the stage bar
// and the budget, from the verified bundle and its timeline. Rows keep what TranscriptRow renders.

type FilmRow = Omit<RunRow, "event">;

function dashboardRun(bundle: RunBundle, timeline: TimelineFile) {
  const rows: FilmRow[] = buildRows(timeline.events, { bundle })
    .filter((r) => r.type === "decision" && showable(`${r.title} ${r.subject ?? ""}`))
    .map(({ event: _event, ...r }) => r);
  const progress = stageProgress(timeline.events, unsafeDecisionIds(bundle));
  const budget = budgetView(timeline.events, bundle.usageByRole);
  return {
    rows,
    stages: progress.steps.map((s) => ({ stage: s.stage, label: s.label, count: s.count, state: s.state })),
    credits: budget ? { used: budget.credits.used, cap: budget.credits.cap } : null,
    toolCalls: budget ? budget.toolCalls.used : null,
    decisions: bundle.decisions.length,
    held: bundle.decisions.filter((d) => d.status === "held").length,
    unsafe: need(bundle.metrics.unsafe_actions_total, `${bundle.runId} metrics.unsafe_actions_total`),
  };
}

/** The held card under a held row, as the Run page builds it (reason and evidence as recorded). */
function heldView(bundle: RunBundle, timeline: TimelineFile, requestId: string, amount: string | null) {
  const row = buildRows(timeline.events, { bundle }).find((r) => r.held && r.title.includes(` ${requestId} `));
  const card = row && heldCard(row, { mode: "replay", sample: bundle.sample, bundle, approvals: null });
  if (!row || !card) throw new Error(`No held card for ${requestId}`);
  return { rowKey: row.key, reason: must(card.reason, "held reason"), evidence: card.evidence.filter(showable), amount };
}

// ------------------------------------------------------------------------------- main

async function main() {
  const index = BundleIndexSchema.parse(await readJsonFile("bundles/fixture/index.json"));
  // landing-data proofPair over published fixture runs: newest guarded queue run, naive from its world.
  const runs = index.filter((e) => e.sample && e.kind === "run").sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const guardedEntry = need(runs.find((e) => e.variant === "guarded"), "a guarded queue run");
  const naiveEntry = need(
    runs.find((e) => e.variant === "naive" && scenarioKey(e.runId) === scenarioKey(guardedEntry.runId)),
    "a naive run from the guarded run's world",
  );
  const load = async (e: BundleIndexEntry) => verifyBundle(await readJsonFile(`bundles/fixture/${e.runId}.json`), e);
  const naive = await load(naiveEntry);
  const guarded = await load(guardedEntry);
  const naiveTimeline = verifyTimeline(await readJsonFile(`bundles/fixture/${naive.runId}.timeline.json`), naive);
  const guardedTimeline = verifyTimeline(await readJsonFile(`bundles/fixture/${guarded.runId}.timeline.json`), guarded);

  // The certificate scenario of this world (web verify chooseScenario: listed, else same world).
  const fixtureIndex = FixtureIndexSchema.parse(await readJsonFile("certificates/fixture/index.json"));
  const key = scenarioKey(guarded.runId);
  const scenario = need(
    fixtureIndex.scenarios.find((s) => s.sourceBundles.includes(guarded.runId)) ??
      fixtureIndex.scenarios.find((s) => s.sourceBundles.some((b) => scenarioKey(b) === key)),
    "a certificate scenario for the guarded run's world",
  );
  if (scenario.scenario !== "default") throw new Error(`Expected the default scenario, got ${scenario.scenario}`);
  const base = `certificates/fixture/${scenario.report.slice(0, scenario.report.lastIndexOf("/") + 1)}`;
  const report = CertificateReportSchema.parse(await readJsonFile(`${base}report.json`));
  if (!report.sample || report.scenario !== scenario.scenario) throw new Error("Certificate report belongs to another world");
  const tools = await Promise.all(
    report.tools.map(async (t) => verifyToolFile(await readJsonFile(`${base}${t.file}`), report.toolFileHashes[t.file], true, t.file)),
  );

  // Notarize runs of this world (the certificates' sources), verified like the queue runs.
  // Newest first, as the web catalog lists them (landing worldNotarizeRuns over the catalog).
  const notarizeEntries = index
    .filter((e) => e.kind === "notarize" && e.sample && scenarioKey(e.runId) === key)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const sources = await Promise.all(notarizeEntries.map(load));

  // ---- naive transcript rows: every money action in queue order, a retried write twice.
  const naiveAmounts = recordedAmounts(naiveTimeline);
  const rows = naive.decisions
    .filter((d) => d.action !== "none")
    .flatMap((d) => {
      const writes = d.effects.filter((e) => e.op === d.action).length;
      const row = {
        requestId: d.requestId,
        type: sentence(words(d.requestType)),
        action: d.action,
        amount: naiveAmounts.get(d.requestId) ?? null,
        unsafe: d.status === "executed" ? (d.grade?.unsafe ?? []).map(words) : [],
        retry: false,
      };
      return writes > 1 ? [{ ...row, unsafe: [] }, { ...row, retry: true }] : [row];
    });
  const naiveUnsafe = need(naive.metrics.unsafe_actions_total, "naive metrics.unsafe_actions_total");
  const graded = naive.decisions.filter((d) => d.status === "executed" && (d.grade?.unsafe?.length ?? 0) > 0).length;
  if (graded !== naiveUnsafe) throw new Error(`Naive unsafe decisions (${graded}) disagree with the grader total (${naiveUnsafe})`);

  // ---- prediction vs observation
  const predict = need(sources.map(predictView).find(Boolean), "a contradicted prediction");
  // ---- challenge
  const challenge = need(challengeView(tools, sources), "an Adversary-reviewed certificate");
  // ---- certificate
  // The certificate the film certifies: the active one behind the allowed Guard row's required
  // beliefs (so the card that lands on that row really covers it), else the landing's featured one.
  const moneyEarly = guarded.decisions.filter((d) => d.action !== "none");
  const allowedEarly = moneyEarly.find((d) => d.status === "executed" && isRefund(d)) ?? moneyEarly.find((d) => d.status === "executed");
  const activeCerts = tools.flatMap((t) => t.certificates).filter((c) => c.status === "active");
  const covering = activeCerts.find((c) => allowedEarly?.requiredBeliefs.includes(c.beliefId));
  const cert = need(covering ?? featuredCertificate(tools), "an active certificate");
  // ---- Guard rows: an executed money action (refund first) and the first held refund with a recorded amount.
  const guardedAmounts = recordedAmounts(guardedTimeline);
  const moneyActions = guarded.decisions.filter((d) => d.action !== "none");
  const allowed = need(
    moneyActions.find((d) => d.status === "executed" && isRefund(d)) ?? moneyActions.find((d) => d.status === "executed"),
    "an executed money action in the guarded run",
  );
  const held = need(
    guarded.decisions.find((d) => d.status === "held" && isRefund(d) && guardedAmounts.has(d.requestId)) ??
      guarded.decisions.find((d) => d.status === "held" && isRefund(d)),
    "a held refund in the guarded run",
  );
  const required = allowed.requiredBeliefs.length;
  // ---- chat
  const chat = await chatTurn(guarded, held.requestId, tools.map((t) => t.tool));

  const data: ShowreelData = {
    source: {
      scenario: scenario.scenario,
      naive: { runId: naive.runId, contentHash: naive.contentHash },
      guarded: { runId: guarded.runId, contentHash: guarded.contentHash },
      notarize: sources.map((b) => ({ runId: b.runId, contentHash: b.contentHash })),
      certificateReport: `${base}report.json`,
    },
    naive: { unsafe: naiveUnsafe, rows },
    guarded: {
      unsafe: need(guarded.metrics.unsafe_actions_total, "guarded metrics.unsafe_actions_total"),
      refundsHeld: guarded.decisions.filter((d) => d.status === "held" && isRefund(d)).length,
      queueSize: guarded.metrics.items_total ?? guarded.decisions.length,
    },
    predict: {
      probe: predict.probe,
      claimId: predict.claimId,
      template: predict.template,
      committedClock: clockUtc(predict.committedAt),
      expected: predict.expected,
      call: predict.call,
      observed: predict.observed,
    },
    challenge: {
      claimId: challenge.claimId,
      hypothesis: must(clipText(need(challenge.hypothesis, "the Reflector hypothesis"), 150), "Reflector hypothesis"),
      counter: must(clipText(challenge.counter, 170), "Adversary counter-test"),
      verdict: challenge.verdict,
      challenges: challenge.challenges,
      survived: challenge.survived,
    },
    certificate: {
      id: cert.id,
      tool: cert.tool,
      claimId: cert.claimId,
      scope: must(clipText(cert.scope.text, 80), "certificate scope"),
      verdict: must(cert.verdict, "certificate verdict"),
      covers: covering && allowedEarly ? allowedEarly.requestId : null,
      evidence: cert.evidence.length,
      issued: dateUtc(cert.issuedAt),
      sha256: cert.sha256,
    },
    guard: {
      allowed: {
        requestId: allowed.requestId,
        type: sentence(words(allowed.requestType)),
        action: allowed.action,
        amount: guardedAmounts.get(allowed.requestId) ?? null,
        detail: `${required} required ${required === 1 ? "belief" : "beliefs"} notarized`,
      },
      held: {
        requestId: held.requestId,
        type: sentence(words(held.requestType)),
        action: held.action,
        amount: guardedAmounts.get(held.requestId) ?? null,
        detail: must(need(recordedGuardReason(guardedTimeline, held.requestId), `the Guard's reason for ${held.requestId}`), "Guard reason"),
      },
    },
    chart: { rows: actionsByType(naive, guarded) },
    dashboard: {
      naive: dashboardRun(naive, naiveTimeline),
      guarded: dashboardRun(guarded, guardedTimeline),
      held: heldView(guarded, guardedTimeline, held.requestId, guardedAmounts.get(held.requestId) ?? null),
    },
    chat,
    builtWith: BUILT_WITH,
    github: GITHUB,
  };

  for (const text of [predict.claimId, predict.probe, ...predict.observed.map((f) => f.value), cert.claimId, chat.question, ...chat.steps.map((s) => s.title)])
    must(text, "on-screen text");

  const parsed = ShowreelDataSchema.parse(data);
  await writeFile(OUT, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
  console.log(
    `naive unsafe ${parsed.naive.unsafe} → guarded ${parsed.guarded.unsafe}; refunds held ${parsed.guarded.refundsHeld} of ${parsed.guarded.queueSize}; ` +
      `certificate ${parsed.certificate.id} (${parsed.certificate.evidence} probes); chat "${parsed.chat.question}"`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
