// Replay Notary Chat: a deterministic engine over the exported bundles, timelines, certificates and
// precomputed explain answers (no backend, no model). It emits the same ChatEvent shapes as the
// live `notary serve` chat:
//
//   note (opening: what matched)  →  per tool: step_started / step_finished (real data from the
//   files; fetch_doc / crustdata_lookup / dodo_lookup → status "unavailable" with the fix)  →
//   text_delta chunks (an answer assembled from the matching explain answer(s) and record facts,
//   [n] markers)  →  citations (every one valid: it names a record a step of this turn returned)
//   →  done (mode "replay", costUsd null, tokens 0).
//
// Notes carry `source: "replay"`: they are written by this engine (code, deterministic), and the
// Chat page tags them "Replay engine", never "Model said" (no model ran).
//
// Worlds never mix: a conversation is pinned to the run selected when it started; only runs,
// certificates, approvals and explain answers of that run's world are read. Durations are measured
// (time spent reading the files); the pauses between events are pacing only and not counted in
// any step's durationMs. Conversations live in sessionStorage (chat-store.ts).
import { SendMessageBodySchema, type Certificate, type ChatCitation, type ChatConversation, type ChatEvent, type ChatMessage, type ChatToolName, type ConversationDetail, type ExplainAnswer, type NoCertificate, type PendingApproval, type RunBundle, type TimelineEvent, type Tool } from "../../../core/src/schema";
import { entryOfBundle } from "./certificates";
import { routeQuestion, type Intent, type LookupTool } from "./chat-route";
import { sessionChatStore, type ChatStore, type StoredConversation } from "./chat-store";
import { TimelineMissingError } from "./published";
import { realTimers, type Timers } from "./stream";
import { byNewest } from "./verify";
import { answerWorld, worldIndex, worldKeyOf, worldLabel, type WorldKey } from "./world";
import type { ChatSource, DataSource, RunEntry } from "./types";

export type ReplayChatData = Pick<DataSource, "listRuns" | "getRun" | "getTimeline" | "certificates" | "approvals" | "explain">;

export type ReplayChatOptions = {
  store?: ChatStore;
  timers?: Timers;
  /** "instant" = no pacing (tests). Default: short pauses so steps and text appear in sequence. */
  pace?: "instant" | { stepMs: number; chunkMs: number };
  /** Monotonic ms clock for durations (default performance.now). */
  now?: () => number;
  /** Wall clock for createdAt/updatedAt (default new Date()). */
  clock?: () => Date;
  /** Id generator (default crypto.randomUUID). */
  newId?: () => string;
};

/** Fix shown in an unavailable step, per live-only tool. */
export const REPLAY_UNAVAILABLE: Record<"fetch_doc" | LookupTool, string> = {
  fetch_doc: "Unavailable in replay — start `pnpm notary serve` to fetch docs pages live",
  crustdata_lookup: "Unavailable in replay — start `pnpm notary serve` with CRUSTDATA_API_KEY set",
  dodo_lookup: "Unavailable in replay — start `pnpm notary serve` with DODO_PAYMENTS_API_KEY set (test mode)",
};

export const REPLAY_NO_MATCH =
  "Replay answers come from the recorded runs only, and this question didn't match any of them. Ask about a held refund (for example its request id), a certificate or claim, revocations, what changed between the naive and guarded runs, the adversary's verdicts, or held actions.";

const DEFAULT_PACE = { stepMs: 140, chunkMs: 14 };
const MAX_ROWS = 20;

class Aborted extends Error {}

type Citable = Omit<ChatCitation, "n" | "valid"> & { terms: string[] };

type StepOutcome = {
  status: "ok" | "error" | "unavailable";
  output: string;
  data?: unknown;
  fix?: string;
  citables?: Citable[];
};

type World = {
  key: WorldKey;
  label: string;
  /** Verified bundles of this world, newest first. */
  runs: RunBundle[];
  selected: RunBundle;
  certificates: Certificate[];
  noCertificates: NoCertificate[];
  explain: ExplainAnswer[];
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, term: string) =>
  term.length > 1 && new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(term)}($|[^A-Za-z0-9_-])`).test(text);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Explain answers are one long paragraph: split into sentences at ". " (code-built sentences may
 * start with a lowercase claim id), never inside a quotation and never inside "P(holds)=0.62".
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const endsHere = /\s/.test(text[i + 1] ?? "") || i + 1 === text.length;
    if (ch === '"') {
      quoted = !quoted;
      // A closing quote right after the punctuation ends the sentence too.
      if (!quoted && /[.!?]/.test(text[i - 1] ?? "") && endsHere) {
        out.push(text.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (!quoted && /[.!?]/.test(ch) && endsHere) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** "FIXTURE scenario x (…): rest" → ["FIXTURE scenario x (…)", "rest"]. */
function splitDisclosure(answer: string): [string | undefined, string] {
  const m = /^((?:FIXTURE|SYNTHETIC)[^:]*\)):\s*/.exec(answer);
  return m ? [m[1], answer.slice(m[0].length)] : [undefined, answer];
}

// --------------------------------------------------------------------------------------- turn

class Turn {
  readonly events: ChatEvent[] = [];
  private steps = 0;
  private readonly citables = new Map<string, Citable>();
  private readonly numbers = new Map<string, number>();
  private readonly started: number;

  constructor(
    private readonly onEvent: (e: ChatEvent) => void,
    private readonly opts: Required<Pick<ReplayChatOptions, "timers" | "now">> & { pace: ReplayChatOptions["pace"] },
    private readonly signal?: AbortSignal,
  ) {
    this.started = opts.now();
  }

  private check() {
    if (this.signal?.aborted) throw new Aborted();
  }

  emit(e: ChatEvent) {
    this.check();
    this.events.push(e);
    this.onEvent(e);
  }

  async pause(kind: "step" | "chunk") {
    const pace = this.opts.pace === "instant" ? 0 : (this.opts.pace ?? DEFAULT_PACE)[kind === "step" ? "stepMs" : "chunkMs"];
    if (pace > 0)
      await new Promise<void>((resolve) => {
        const handle = this.opts.timers.set(() => {
          this.signal?.removeEventListener("abort", stop);
          resolve();
        }, pace);
        const stop = () => {
          this.opts.timers.clear(handle);
          resolve();
        };
        this.signal?.addEventListener("abort", stop, { once: true });
      });
    this.check();
  }

  async note(text: string) {
    this.emit({ type: "note", text: clip(text, 200), source: "replay" });
    await this.pause("step");
  }

  async step(tool: ChatToolName, title: string, input: string, run: () => Promise<StepOutcome>): Promise<StepOutcome> {
    const id = `s${++this.steps}`;
    this.emit({ type: "step_started", id, tool, title, input: clip(input, 160) });
    const t0 = this.opts.now();
    let outcome: StepOutcome;
    try {
      outcome = await run();
    } catch (e) {
      if (e instanceof Aborted || this.signal?.aborted) throw new Aborted();
      outcome = { status: "error", output: e instanceof Error ? clip(e.message, 200) : "The step failed." };
    }
    const durationMs = Math.max(0, Math.round(this.opts.now() - t0));
    this.emit({
      type: "step_finished",
      id,
      status: outcome.status,
      durationMs,
      costUsd: null,
      output: clip(outcome.output, 240),
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      ...(outcome.fix ? { fix: outcome.fix } : {}),
    });
    for (const c of outcome.citables ?? []) {
      const key = `${c.type}:${c.id}`;
      if (!this.citables.has(key)) this.citables.set(key, { ...c, stepId: id });
    }
    await this.pause("step");
    return outcome;
  }

  get stepCount() {
    return this.steps;
  }

  /** "[n]" markers for these records (by "<type>:<id>"); unknown keys are skipped, never invented. */
  cite(...keys: string[]): string {
    const out: number[] = [];
    for (const key of keys) {
      if (!this.citables.has(key)) continue;
      if (!this.numbers.has(key)) this.numbers.set(key, this.numbers.size + 1);
      const n = this.numbers.get(key)!;
      if (!out.includes(n)) out.push(n);
    }
    return out
      .sort((a, b) => a - b)
      .map((n) => `[${n}]`)
      .join("");
  }

  /** Markers for every record of this turn the sentence names (by id terms). */
  citeMentions(sentence: string, limit = 3): string {
    const keys = [...this.citables].filter(([, c]) => c.terms.some((t) => mentions(sentence, t))).map(([k]) => k);
    return this.cite(...keys.slice(0, limit));
  }

  hasCitable(key: string) {
    return this.citables.has(key);
  }

  async answer(markdown: string): Promise<void> {
    // Chunks of a few words, so the answer streams like the live one.
    const parts = markdown.match(/\S+\s*|\s+/g) ?? [];
    for (let i = 0; i < parts.length; i += 4) {
      this.emit({ type: "text_delta", text: parts.slice(i, i + 4).join("") });
      if (i + 4 < parts.length) await this.pause("chunk");
    }
    const items: ChatCitation[] = [...this.numbers]
      .sort((a, b) => a[1] - b[1])
      .map(([key, n]) => {
        const { terms: _t, ...c } = this.citables.get(key)!;
        return { ...c, n, valid: true };
      });
    this.emit({ type: "citations", items });
    this.emit({
      type: "done",
      costUsd: null,
      tokens: { input: 0, output: 0 },
      steps: this.steps,
      durationMs: Math.max(0, Math.round(this.opts.now() - this.started)),
      mode: "replay",
    });
  }
}

// ------------------------------------------------------------------------------------ helpers

const runCitable = (b: RunBundle): Citable => ({ type: "run", id: b.runId, label: b.runId, terms: [b.runId] });

const eventCitable = (e: TimelineEvent): Citable => ({
  type: "run_event",
  id: `${e.runId}#${e.seq}`,
  label: clip(e.summary, 90),
  // Request ids ("q02"), claim and certificate ids the event is about.
  terms: e.recordIds.filter((r) => !r.includes(":") && !r.startsWith("belief-") && !r.startsWith("hyp-")),
});

const certCitable = (c: Certificate): Citable => ({
  type: "certificate",
  id: c.id,
  label: `${c.claimId} (${c.status})`,
  terms: [c.id, c.claimId],
});

const approvalCitable = (a: PendingApproval): Citable => ({
  type: "approval",
  id: a.id ?? `${a.runId}:${a.decisionId}`,
  label: `${a.requestId} in ${a.runId}`,
  terms: [],
});

const eventRow = (e: TimelineEvent) => ({ runId: e.runId, seq: e.seq, at: e.at, type: e.type, stage: e.stage, summary: e.summary });

const certificateData = (c: Certificate) => ({
  kind: "certificate" as const,
  id: c.id,
  tool: c.tool,
  claimId: c.claimId,
  status: c.status,
  verdict: c.verdict,
  verdictKind: c.verdictKind,
  scope: c.scope.narrowed?.text ?? c.scope.text,
  evidenceCount: c.evidence.length,
  confidence: c.confidence,
  docUrl: c.docUrl,
  docsSay: c.docsSay,
  observed: c.observed,
  issuedAt: c.issuedAt,
  ...(c.revocation ? { revokedAt: c.revocation.revokedAt } : {}),
});

const approvalData = (a: PendingApproval) => ({
  id: a.id ?? null,
  runId: a.runId,
  requestId: a.requestId,
  action: a.action,
  reason: a.reason,
  missingBeliefs: a.missingBeliefs,
});

const claimOfBelief = (beliefId: string) => beliefId.replace(/^belief-/, "");

// ------------------------------------------------------------------------------------- engine

export class ReplayChat implements ChatSource {
  private readonly store: ChatStore;
  private readonly timers: Timers;
  private readonly pace: ReplayChatOptions["pace"];
  private readonly now: () => number;
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private runId: string | undefined;

  constructor(
    private readonly data: ReplayChatData,
    opts: ReplayChatOptions = {},
  ) {
    this.store = opts.store ?? sessionChatStore();
    this.timers = opts.timers ?? realTimers;
    this.pace = opts.pace;
    this.now = opts.now ?? (() => (globalThis.performance ?? Date).now());
    this.clock = opts.clock ?? (() => new Date());
    this.newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  }

  /** The run selected in the dashboard; a new conversation answers from its world only. */
  setContext(ctx: { runId?: string }): void {
    this.runId = ctx.runId;
  }

  async listConversations(): Promise<ChatConversation[]> {
    return this.store
      .load()
      .map((c) => c.conversation)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConversation(id: string): Promise<ConversationDetail> {
    const found = this.store.load().find((c) => c.conversation.id === id);
    if (!found) throw new Error(`Conversation ${id} is not in this tab's replay history.`);
    return { conversation: found.conversation, messages: found.messages };
  }

  async createConversation(): Promise<ChatConversation> {
    const at = this.clock().toISOString();
    const conversation: ChatConversation = { id: `replay-${this.newId()}`, title: "New chat", createdAt: at, updatedAt: at };
    this.store.save([{ conversation, runId: this.runId, messages: [] }, ...this.store.load()]);
    return conversation;
  }

  async deleteConversation(id: string): Promise<void> {
    this.store.save(this.store.load().filter((c) => c.conversation.id !== id));
  }

  /** The world a conversation answers from (pinned run), for the page's label. */
  async conversationWorld(id: string): Promise<{ runId: string; world: WorldKey; label: string } | undefined> {
    const runId = this.store.load().find((c) => c.conversation.id === id)?.runId;
    if (!runId) return undefined;
    try {
      const b = await this.data.getRun(runId);
      const key = worldKeyOf(b);
      return { runId, world: key, label: worldLabel(key) };
    } catch {
      return undefined;
    }
  }

  private update(id: string, fn: (c: StoredConversation) => StoredConversation) {
    this.store.save(this.store.load().map((c) => (c.conversation.id === id ? fn(c) : c)));
  }

  async sendMessage(
    conversationId: string,
    content: string,
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = SendMessageBodySchema.safeParse({ content });
    if (!body.success) {
      onEvent({ type: "error", message: "Type a question (at most 4000 characters)." });
      return;
    }
    const stored = this.store.load().find((c) => c.conversation.id === conversationId);
    if (!stored) {
      onEvent({ type: "error", message: "This conversation is not in this tab's replay history.", fix: "Start a new chat." });
      return;
    }
    const question = body.data.content;
    const at = () => this.clock().toISOString();
    const userMessage: ChatMessage = { id: this.newId(), conversationId, role: "user", content: question, createdAt: at() };
    const pinned = stored.runId ?? this.runId;
    this.update(conversationId, (c) => ({
      ...c,
      runId: pinned,
      conversation: { ...c.conversation, title: c.messages.length ? c.conversation.title : clip(question.replace(/\s+/g, " "), 60), updatedAt: at() },
      messages: [...c.messages, userMessage],
    }));
    const previous = [...stored.messages].reverse().find((m) => m.role === "assistant")?.events?.find((e) => e.type === "citations");
    const turn = new Turn(onEvent, { timers: this.timers, now: this.now, pace: this.pace }, signal);
    let text = "";
    const record = (e: ChatEvent) => {
      if (e.type === "text_delta") text += e.text;
    };
    try {
      const world = await this.loadWorld(pinned, signal);
      if (!world) {
        turn.emit({ type: "error", message: "No published run to answer from.", fix: "Publish verified exports with `pnpm notary export`." });
      } else {
        await this.answer(turn, question, world, previous?.type === "citations" ? previous.items : undefined);
      }
    } catch (e) {
      if (!(e instanceof Aborted) && !signal?.aborted)
        try {
          turn.emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } catch {
          // aborted while reporting
        }
    }
    for (const e of turn.events) record(e);
    const assistant: ChatMessage = {
      id: this.newId(),
      conversationId,
      role: "assistant",
      content: text,
      events: turn.events,
      createdAt: at(),
    };
    this.update(conversationId, (c) => ({ ...c, conversation: { ...c.conversation, updatedAt: at() }, messages: [...c.messages, assistant] }));
  }

  // ------------------------------------------------------------------------------ world

  private async loadWorld(runId: string | undefined, signal?: AbortSignal): Promise<World | undefined> {
    const entries = (await this.data.listRuns(signal)).filter((r): r is Extract<RunEntry, { state: "finished" }> => r.state === "finished");
    if (!entries.length) return undefined;
    const bundles = (await Promise.all(entries.map((e) => this.data.getRun(e.runId, signal)))).sort(byNewest);
    const selected =
      bundles.find((b) => b.runId === runId) ?? bundles.find((b) => !b.sample) ?? bundles[0]!;
    const key = worldKeyOf(selected);
    const runs = bundles.filter((b) => worldKeyOf(b) === key);
    let certificates: Certificate[] = [];
    let noCertificates: NoCertificate[] = [];
    try {
      const cw = await this.data.certificates(entryOfBundle(selected), signal);
      // Only a certificate world that is provably this world (never another scenario's).
      if (cw.report && cw.world === key) {
        certificates = cw.tools.flatMap((t) => t.certificates);
        noCertificates = cw.tools.flatMap((t) => t.noCertificates);
      }
    } catch {
      // No certificates for this world: certificate steps say so.
    }
    let explain: ExplainAnswer[] = [];
    try {
      const file = await this.data.explain(signal);
      const worlds = worldIndex(bundles);
      explain = (file?.answers ?? []).filter((a) => answerWorld(a, worlds) === key);
    } catch {
      // Explain answers withheld: answers use record facts only.
    }
    return { key, label: worldLabel(key), runs, selected, certificates, noCertificates, explain };
  }

  private async timeline(runId: string): Promise<TimelineEvent[] | undefined> {
    try {
      return await this.data.getTimeline(runId);
    } catch (e) {
      if (e instanceof TimelineMissingError) return undefined;
      throw e;
    }
  }

  // ----------------------------------------------------------------------------- answer

  private async answer(turn: Turn, question: string, world: World, previous?: ChatCitation[]) {
    const claimIds = [...new Set([...world.certificates.map((c) => c.claimId), ...world.noCertificates.map((c) => c.claimId)])];
    const route = routeQuestion(question, { runIds: world.runs.map((r) => r.runId), claimIds, previous });
    const blocks: string[] = [];
    if (world.key !== "real") blocks.push("*Answering from recorded scenario runs, not live data.*");
    if (!route.intents.length) {
      await turn.note(`Nothing in the question matched a recorded record of ${world.label}; listing what is recorded.`);
      await this.listRuns(turn, world);
      blocks.push(REPLAY_NO_MATCH);
      return turn.answer(blocks.join("\n\n"));
    }
    await turn.note(`Matched ${route.matched.join(", ")}; reading ${world.label}.`);
    for (const intent of await this.expand(route.intents, world)) {
      const md = await this.run(turn, intent, world);
      if (md) blocks.push(md);
    }
    return turn.answer(blocks.join("\n\n"));
  }

  /** Follow-ups become concrete intents: the cited record decides which. */
  private async expand(intents: Intent[], world: World): Promise<Intent[]> {
    const out: Intent[] = [];
    for (const i of intents) {
      if (i.kind !== "followup") {
        out.push(i);
        continue;
      }
      const c = i.citation;
      if (c.type === "certificate") out.push({ kind: "certificate", certId: c.id });
      else if (c.type === "approval") out.push({ kind: "approvals", approvalId: c.id });
      else if (c.type === "run") out.push({ kind: "runs", runId: c.id });
      else if (c.type === "run_event") {
        const [runId, seq] = [c.id.slice(0, c.id.lastIndexOf("#")), Number(c.id.slice(c.id.lastIndexOf("#") + 1))];
        const ev = world.runs.some((r) => r.runId === runId) ? (await this.timeline(runId))?.find((e) => e.seq === seq) : undefined;
        const requestId = ev?.type === "decision" ? (ev.data?.requestId as string | undefined) : undefined;
        const claimId = ev?.data?.claimId as string | undefined;
        if (requestId) out.push({ kind: "why_held", requestId, runId });
        else if (claimId) out.push({ kind: "certificate", claimId });
        else out.push({ kind: "runs", runId });
      }
    }
    // De-duplicate (a follow-up may repeat a keyword intent).
    return out.filter((x, idx) => out.findIndex((y) => JSON.stringify(y) === JSON.stringify(x)) === idx);
  }

  private run(turn: Turn, intent: Intent, world: World): Promise<string | undefined> {
    switch (intent.kind) {
      case "lookup":
        return this.lookup(turn, intent.tool, intent.subject);
      case "doc":
        return this.doc(turn, intent.url);
      case "health":
        return this.health(turn);
      case "why_held":
        return this.whyHeld(turn, world, intent.requestId, intent.runId);
      case "certificate":
        return this.certificate(turn, world, intent);
      case "revocations":
        return this.revocations(turn, world);
      case "run_diff":
        return this.runDiff(turn, world);
      case "adversary":
        return this.adversary(turn, world);
      case "approvals":
        return this.approvals(turn, world, intent.approvalId, intent.requestId);
      case "runs":
        return this.runs(turn, world, intent.runId);
      case "followup":
        return Promise.resolve(undefined);
    }
  }

  // -------------------------------------------------------------------------- live-only

  private async lookup(turn: Turn, tool: LookupTool, subject: string) {
    const name = tool === "crustdata_lookup" ? "Crustdata" : "Dodo Payments";
    await turn.step(tool, `Looking up ${clip(subject, 60)} in ${name}`, subject, async () => ({
      status: "unavailable",
      output: "Unavailable in replay",
      fix: REPLAY_UNAVAILABLE[tool],
    }));
    return `Looking up ${subject} needs a live ${name} call, which replay can't make. ${REPLAY_UNAVAILABLE[tool].replace("Unavailable in replay — s", "S")} and ask again.`;
  }

  private async doc(turn: Turn, url?: string) {
    const where = url ? clip(url.replace(/^https?:\/\//, ""), 60) : "the docs";
    await turn.step("fetch_doc", `Opening ${where}`, url ?? "docs", async () => ({
      status: "unavailable",
      output: "Unavailable in replay",
      fix: REPLAY_UNAVAILABLE.fetch_doc,
    }));
    return "Docs pages are fetched live, which replay can't do. The certificates below quote the docs text each claim was tested against.";
  }

  private async health(turn: Turn) {
    await turn.step("get_health", "Checking integrations", "health", async () => ({
      status: "ok",
      output: "Replay: no live integrations are connected",
      data: { kind: "health", mode: "replay", integrations: [] },
    }));
    return "This is a replay of recorded runs, so nothing is connected: Crustdata, Dodo Payments, the model proxy and neatlogs are only checked by a local `pnpm notary serve`. Its Report page lists each connection with the exact variable to set.";
  }

  // ---------------------------------------------------------------------------- records

  private async listRuns(turn: Turn, world: World) {
    return turn.step("list_runs", `Listing runs in ${world.label}`, world.key, async () => ({
      status: "ok",
      output: `${world.runs.length} run${world.runs.length === 1 ? "" : "s"} in ${world.label}`,
      data: {
        kind: "runs",
        world: world.key,
        runs: world.runs.map((b) => ({ runId: b.runId, kind: b.kind, variant: b.variant, status: b.status, startedAt: b.startedAt, sample: b.sample })),
      },
      citables: world.runs.map(runCitable),
    }));
  }

  private async runEvents(turn: Turn, run: RunBundle, label: string, filter: (e: TimelineEvent) => boolean) {
    let rows: TimelineEvent[] = [];
    const outcome = await turn.step("get_run_events", `Reading ${label} of ${run.runId}`, run.runId, async () => {
      const events = await this.timeline(run.runId);
      if (!events)
        return { status: "unavailable", output: `No timeline is published for ${run.runId}`, fix: "Publish it with `pnpm notary export`" };
      rows = events.filter(filter);
      const shown = rows.slice(0, MAX_ROWS);
      return {
        status: "ok",
        output: `${rows.length} event${rows.length === 1 ? "" : "s"}: ${label}${rows.length > shown.length ? ` (first ${shown.length} shown)` : ""}`,
        data: { kind: "run_events", runId: run.runId, total: rows.length, events: shown.map(eventRow) },
        citables: [runCitable(run), ...shown.map(eventCitable)],
      };
    });
    return { rows: outcome.status === "ok" ? rows : undefined };
  }

  private async getCertificate(turn: Turn, c: Certificate) {
    await turn.step("get_certificate", `Checking certificate ${c.claimId}`, c.id, async () => ({
      status: "ok",
      output: `${c.status === "revoked" ? "Revoked" : "Active"}: ${c.verdict}`,
      data: certificateData(c),
      citables: [certCitable(c)],
    }));
  }

  private explainSentences(turn: Turn, answer: ExplainAnswer, keep?: (s: string) => boolean, max = 8): string {
    const [disclosure, body] = splitDisclosure(answer.answer);
    void disclosure; // the answer opens with the world line instead
    const picked = sentences(body).filter((s) => !keep || keep(s)).slice(0, max);
    if (!picked.length) return "";
    const lines = picked.map((s) => {
      const markers = turn.citeMentions(s);
      return markers ? `${s} ${markers}` : s;
    });
    // Short paragraphs of three sentences read better than one block.
    const paras: string[] = [];
    for (let i = 0; i < lines.length; i += 3) paras.push(lines.slice(i, i + 3).join(" "));
    return paras.join("\n\n");
  }

  private async whyHeld(turn: Turn, world: World, requestId?: string, runId?: string) {
    const guardedFirst = [...world.runs].sort((a, b) => Number(b.variant === "guarded") - Number(a.variant === "guarded"));
    const decisionOf = (b: RunBundle) => b.decisions.find((d) => d.requestId === requestId);
    let run =
      world.runs.find((b) => b.runId === runId) ??
      (requestId
        ? [world.selected, ...guardedFirst].find((b) => decisionOf(b)?.status === "held") ??
          [world.selected, ...guardedFirst].find((b) => decisionOf(b))
        : world.selected.decisions.some((d) => d.status === "held")
          ? world.selected
          : guardedFirst.find((b) => b.decisions.some((d) => d.status === "held")));
    if (!run) {
      await this.listRuns(turn, world);
      return requestId
        ? `No recorded run in ${world.label} has a request ${requestId}. ${turn.cite(...world.runs.map((r) => `run:${r.runId}`).slice(0, 2))}`.trim()
        : `No recorded run in ${world.label} held anything.`;
    }
    if (!requestId) {
      const { rows } = await this.runEvents(turn, run, "held decisions", (e) => e.type === "decision" && e.data?.status === "held");
      if (!rows) return `${run.runId} has no published timeline, so its held decisions can't be listed here.`;
      if (!rows.length) return `Nothing was held in ${run.runId}. ${turn.cite(`run:${run.runId}`)}`;
      const list = rows
        .slice(0, MAX_ROWS)
        .map((e) => `- ${e.summary} ${turn.cite(`run_event:${e.runId}#${e.seq}`)}`)
        .join("\n");
      return `${rows.length} decision${rows.length === 1 ? " was" : "s were"} held in ${run.runId}:\n\n${list}\n\nAsk “Why was ${String(rows[0]!.data?.requestId ?? "it")} held?” for the reasons behind one.`;
    }
    const decision = decisionOf(run)!;
    const { rows } = await this.runEvents(turn, run, `the decision for ${requestId}`, (e) => e.type === "decision" && e.recordIds.includes(requestId));
    const event = rows?.[0];
    const lead = event ? `${event.summary} ${turn.cite(`run_event:${event.runId}#${event.seq}`)}` : `${requestId} in ${run.runId} ended ${decision.status}.`;
    if (decision.status !== "held") return `${requestId} was not held in ${run.runId}. ${lead}`;
    // The held action, as the approval desk lists it (read-only in replay).
    let approval: PendingApproval | undefined;
    await turn.step("get_approval", `Opening the held action ${requestId}`, `${run.runId} ${requestId}`, async () => {
      const list = await this.data.approvals();
      approval = list.pending.find((a) => a.runId === run!.runId && a.decisionId === decision.id);
      return approval
        ? { status: "ok", output: `Held: ${approval.action} — read-only in replay`, data: { kind: "approval", readOnly: true, ...approvalData(approval) }, citables: [approvalCitable(approval)] }
        : { status: "error", output: `No held action is listed for ${requestId} in ${run!.runId}` };
    });
    // Certificates behind the claims the decision needed (missing beliefs, applied guards).
    const claims = new Set<string>([
      ...decision.missingBeliefs.map(claimOfBelief),
      ...decision.guardsApplied.flatMap((g) => run!.guards.filter((x) => x.id === g).map((x) => claimOfBelief(x.beliefId))),
    ]);
    const certs = [...claims]
      .map((claim) => world.certificates.filter((c) => c.claimId === claim).sort((a, b) => Number(a.status === "revoked") - Number(b.status === "revoked"))[0])
      .filter((c): c is Certificate => Boolean(c))
      .slice(0, 2);
    for (const c of certs) await this.getCertificate(turn, c);
    const explain = world.explain.find((a) => a.kind === "why_held" && a.runIds.includes(run!.runId) && a.citations.some((c) => c.kind === "decision" && c.id === decision.id));
    const blocks = [lead];
    if (explain) blocks.push(this.explainSentences(turn, explain, undefined, 9));
    else if (decision.missingBeliefs.length)
      blocks.push(`It needed notarized beliefs that were missing: ${decision.missingBeliefs.map((b) => `\`${claimOfBelief(b)}\``).join(", ")}.`);
    for (const c of certs) blocks.push(`Certificate for \`${c.claimId}\`: ${c.status}, ${c.verdict.replace(/\.$/, "")}. ${turn.cite(`certificate:${c.id}`)}`);
    if (approval)
      blocks.push(`The held action is read-only here; approving or rejecting it needs \`pnpm notary serve\` (Approvals page). ${turn.cite(`approval:${approval.id ?? `${approval.runId}:${approval.decisionId}`}`)}`);
    if (explain) blocks.push(`*Source: precomputed answer \`${explain.id}\` (notary export --explain).*`);
    return blocks.filter(Boolean).join("\n\n");
  }

  private async certificate(turn: Turn, world: World, intent: Extract<Intent, { kind: "certificate" }>) {
    const { certId, tool } = intent;
    let claimId = intent.claimId;
    if (certId && !claimId) claimId = world.certificates.find((c) => c.id === certId)?.claimId;
    const query = certId ?? claimId ?? tool ?? "all";
    let results: Certificate[] = [];
    let missing: NoCertificate[] = [];
    await turn.step("search_certificates", `Searching certificates for ${query}`, query, async () => {
      if (!world.certificates.length && !world.noCertificates.length)
        return { status: "ok", output: `No certificates are published for ${world.label}`, data: { kind: "certificates", world: world.key, results: [] } };
      const match = (c: { tool: Tool; claimId: string; id?: string }) =>
        certId ? c.id === certId : claimId ? c.claimId === claimId : tool ? c.tool === tool : true;
      results = world.certificates.filter(match).sort((a, b) => Number(a.status === "revoked") - Number(b.status === "revoked"));
      missing = certId ? [] : world.noCertificates.filter(match);
      return {
        status: "ok",
        output: `${results.length} certificate${results.length === 1 ? "" : "s"}${missing.length ? `, ${missing.length} claim${missing.length === 1 ? "" : "s"} without one` : ""}`,
        data: {
          kind: "certificates",
          world: world.key,
          results: results.slice(0, MAX_ROWS).map((c) => ({ id: c.id, tool: c.tool, claimId: c.claimId, status: c.status, verdict: c.verdictKind.replace("_", " "), confidence: c.confidence, evidence: c.evidence.length })),
          ...(missing.length ? { noCertificates: missing.slice(0, MAX_ROWS).map((n) => ({ claimId: n.claimId, kind: n.kind, reason: n.reason })) } : {}),
        },
        citables: results.slice(0, MAX_ROWS).map(certCitable),
      };
    });
    const focus = certId || claimId ? results.slice(0, 1) : results.filter((c) => c.status === "active").slice(0, 2);
    for (const c of focus) await this.getCertificate(turn, c);
    const blocks: string[] = [];
    if (!results.length && !missing.length) return `No certificate in ${world.label} matches ${query}.`;
    for (const c of focus) {
      const n = turn.cite(`certificate:${c.id}`);
      blocks.push(
        [
          `**\`${c.claimId}\`** — certificate \`${c.id}\` is ${c.status}${c.revocation ? ` (revoked ${c.revocation.revokedAt})` : ""}. ${n}`,
          `- Verdict: ${c.verdict.replace(/\.$/, "")}, P(doc claim holds) = ${pct(c.confidence)} ${n}`,
          `- Docs say: ${clip(c.docsSay, 220)}`,
          `- Observed: ${clip(c.observed, 220)}`,
          `- Scope: ${clip(c.scope.narrowed?.text ?? c.scope.text, 220)}`,
          `- Evidence: ${c.evidence.length} probe${c.evidence.length === 1 ? "" : "s"}`,
        ].join("\n"),
      );
    }
    for (const n of missing.slice(0, claimId ? 1 : 3))
      blocks.push(`\`${n.claimId}\` has no active certificate (${n.kind.replaceAll("_", " ")}): ${clip(n.reason, 220)}`);
    if (!claimId && !certId && results.length > focus.length)
      blocks.push(`${results.length - focus.length} more certificate${results.length - focus.length === 1 ? "" : "s"} in the search results above.`);
    const knowledge = world.explain.find((a) => a.kind === "tool_knowledge" && (tool ? a.id.endsWith(`:${tool}`) : claimId ? a.id.endsWith(`:${claimId.split(".")[0]}`) : false));
    if (knowledge) {
      const text = this.explainSentences(turn, knowledge, claimId ? (s) => s.includes(claimId!) : undefined, claimId ? 3 : 4);
      if (text) blocks.push(text, `*Source: precomputed answer \`${knowledge.id}\` (notary export --explain).*`);
    }
    return blocks.join("\n\n");
  }

  private async revocations(turn: Turn, world: World) {
    const revoked = world.certificates.filter((c) => c.status === "revoked");
    await turn.step("search_certificates", "Searching revoked certificates", "status:revoked", async () => ({
      status: "ok",
      output: `${revoked.length} revoked of ${world.certificates.length} certificates`,
      data: { kind: "certificates", world: world.key, results: revoked.map((c) => ({ id: c.id, tool: c.tool, claimId: c.claimId, status: c.status, verdict: c.verdictKind.replace("_", " "), confidence: c.confidence, evidence: c.evidence.length })) },
      citables: revoked.map(certCitable),
    }));
    for (const c of revoked.slice(0, 2)) await this.getCertificate(turn, c);
    if (!revoked.length) return `No certificate was revoked in ${world.label}.`;
    const explain = world.explain.find((a) => a.kind === "revocations");
    const blocks = [`${revoked.length} certificate${revoked.length === 1 ? " was" : "s were"} revoked in ${world.label}. ${turn.cite(...revoked.map((c) => `certificate:${c.id}`))}`];
    if (explain) blocks.push(this.explainSentences(turn, explain, undefined, 6), `*Source: precomputed answer \`${explain.id}\` (notary export --explain).*`);
    return blocks.join("\n\n");
  }

  private async runDiff(turn: Turn, world: World) {
    await this.listRuns(turn, world);
    const scenario = (id: string) => id.replace(/-(run|notarize)-[a-z]+$/, "");
    const pairs = world.runs
      .filter((b) => b.kind === "run" && b.variant === "guarded")
      .map((g) => ({ guarded: g, naive: world.runs.find((b) => b.kind === "run" && b.variant === "naive" && scenario(b.runId) === scenario(g.runId)) }))
      .filter((p): p is { guarded: RunBundle; naive: RunBundle } => Boolean(p.naive));
    const pair = pairs.find((p) => p.guarded.runId === world.selected.runId || p.naive.runId === world.selected.runId) ?? pairs[0];
    if (!pair) return `${world.label} has no naive and guarded run pair to compare.`;
    const changed = pair.guarded.decisions.filter((d) => pair.naive.decisions.find((n) => n.requestId === d.requestId)?.status !== d.status);
    const ids = new Set(changed.map((d) => d.requestId));
    await this.runEvents(turn, pair.guarded, "decisions that changed status", (e) => e.type === "decision" && e.recordIds.some((r) => ids.has(r)));
    const explain = world.explain.find((a) => a.kind === "run_diff" && a.runIds.includes(pair.guarded.runId) && a.runIds.includes(pair.naive.runId));
    const blocks = [
      `From \`${pair.naive.runId}\` to \`${pair.guarded.runId}\`, ${changed.length} of ${pair.guarded.decisions.length} queue items changed status. ${turn.cite(`run:${pair.naive.runId}`, `run:${pair.guarded.runId}`)}`,
    ];
    if (explain) blocks.push(this.explainSentences(turn, explain, (s) => !/^\d+ items kept/.test(s), 6), `*Source: precomputed answer \`${explain.id}\` (notary export --explain).*`);
    return blocks.join("\n\n");
  }

  private async adversary(turn: Turn, world: World) {
    await this.listRuns(turn, world);
    // "The last run" = the newest run of this world that recorded adversary verdicts.
    let chosen: { run: RunBundle; verdicts: TimelineEvent[] } | undefined;
    for (const run of world.runs) {
      const events = await this.timeline(run.runId);
      const verdicts = events?.filter((e) => e.type === "adversary.verdict") ?? [];
      if (verdicts.length) {
        chosen = { run, verdicts };
        break;
      }
    }
    if (!chosen) return `No run in ${world.label} recorded an adversary verdict.`;
    const newest = world.runs[0]!;
    if (newest.runId !== chosen.run.runId)
      await turn.note(`${newest.runId} is newer but recorded no adversary verdicts; using ${chosen.run.runId}.`);
    const { rows } = await this.runEvents(turn, chosen.run, "adversary verdicts", (e) => e.type === "adversary.verdict");
    const all = rows ?? chosen.verdicts;
    const rejected = all.filter((e) => e.data?.verdict !== "uphold");
    const models = [...new Set(all.map((e) => (typeof e.data?.model === "string" ? e.data.model : undefined)).filter(Boolean))];
    const tally = all.reduce<Record<string, number>>((acc, e) => {
      const v = String(e.data?.verdict ?? "unknown");
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});
    const blocks = [
      `In \`${chosen.run.runId}\` the adversary reviewed ${all.length} belief${all.length === 1 ? "" : "s"}: ${Object.entries(tally).map(([v, n]) => `${v} ×${n}`).join(", ")}${models.length ? ` (model ${models.join(", ")}, as recorded)` : " (model not recorded)"}. ${turn.cite(`run:${chosen.run.runId}`)}`,
    ];
    if (!rejected.length) blocks.push("It upheld every belief it reviewed: nothing was rejected.");
    else
      blocks.push(
        `It rejected ${rejected.length} (downgraded or narrowed):\n\n${rejected
          .slice(0, MAX_ROWS)
          .map((e) => `- ${e.summary} ${turn.cite(`run_event:${e.runId}#${e.seq}`)}`)
          .join("\n")}`,
      );
    return blocks.join("\n\n");
  }

  private async approvals(turn: Turn, world: World, approvalId?: string, requestId?: string) {
    const runs = new Set(world.runs.map((r) => r.runId));
    let items: PendingApproval[] = [];
    await turn.step("list_approvals", "Listing held actions", world.key, async () => {
      const list = await this.data.approvals();
      items = list.pending.filter((a) => runs.has(a.runId));
      const shown = items.slice(0, MAX_ROWS);
      return {
        status: "ok",
        output: `${items.length} held action${items.length === 1 ? "" : "s"} in recorded runs (read-only in replay)`,
        data: { kind: "approvals", readOnly: true, total: items.length, items: shown.map(approvalData) },
        citables: shown.map(approvalCitable),
      };
    });
    const one = items.find((a) => (approvalId && a.id === approvalId) || (requestId && a.requestId === requestId));
    if (one) {
      await turn.step("get_approval", `Opening the held action ${one.requestId}`, one.id ?? one.decisionId, async () => ({
        status: "ok",
        output: `Held: ${one.action}`,
        data: { kind: "approval", readOnly: true, ...approvalData(one) },
        citables: [approvalCitable(one)],
      }));
      return `${one.requestId} in \`${one.runId}\` is held: ${one.action}. Recorded reason: ${clip(one.reason, 240)} ${turn.cite(`approval:${one.id ?? `${one.runId}:${one.decisionId}`}`)}\n\nIt is read-only here; approving or rejecting needs \`pnpm notary serve\`.`;
    }
    if (approvalId) return `Approval ${approvalId} is not a held action of ${world.label}.`;
    if (!items.length) return `No action is held in the recorded runs of ${world.label}.`;
    const byRun = new Map<string, PendingApproval[]>();
    for (const a of items) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
    return [
      `${items.length} action${items.length === 1 ? " is" : "s are"} held in the recorded runs of ${world.label}. In replay they are read-only; \`pnpm notary serve\` shows the live approval desk.`,
      [...byRun]
        .map(([run, list]) => `- \`${run}\`: ${list.map((a) => `${a.requestId} ${turn.cite(`approval:${a.id ?? `${a.runId}:${a.decisionId}`}`)}`).join(", ")}`)
        .join("\n"),
    ].join("\n\n");
  }

  private async runs(turn: Turn, world: World, runId?: string) {
    await this.listRuns(turn, world);
    const run = world.runs.find((r) => r.runId === runId) ?? world.selected;
    const { rows } = await this.runEvents(turn, run, "the run's outcome", (e) => e.type === "run.finished" || e.type === "certificate.revoked" || e.type === "certificate.issued");
    const finished = rows?.find((e) => e.type === "run.finished");
    const held = run.decisions.filter((d) => d.status === "held").length;
    const lines = [
      `${world.runs.length} run${world.runs.length === 1 ? " is" : "s are"} recorded in ${world.label}: ${world.runs.map((r) => `\`${r.runId}\` (${r.kind}, ${r.variant}) ${turn.cite(`run:${r.runId}`)}`).join(", ")}.`,
    ];
    lines.push(
      finished
        ? `\`${run.runId}\`: ${finished.summary} ${turn.cite(`run_event:${finished.runId}#${finished.seq}`)}`
        : `\`${run.runId}\` ended ${run.status}${run.decisions.length ? ` with ${held} of ${run.decisions.length} decisions held` : ""}. ${turn.cite(`run:${run.runId}`)}`,
    );
    return lines.join("\n\n");
  }
}
