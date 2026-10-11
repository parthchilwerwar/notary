// The Notary Chat agent loop: one user message -> tool steps -> one streamed, cited answer.
//
// Provider-agnostic (works the same on LiteLLM and Bedrock through LlmClient, executor role):
//   1. Action phase, at most `maxSteps` (8) tool steps. Each model call must reply with ONE JSON
//      object, validated with zod:
//        {"note": "<≤20 words>", "tool": "<ChatToolName>", "args": {...}}   or   {"note"?: "...", "final": true}
//      and the args are validated by the tool's own zod schema. A malformed reply gets one corrective
//      retry; a second malformed reply ends the turn with an `error` event (steps so far are kept).
//      The model's note becomes a `note` event (source "model", ≤ 20 words, ≤ 200 chars) before the step.
//   2. Answer phase: one more call, streamed (LlmClient onText: LiteLLM `stream: true`; Bedrock and
//      doubles deliver the whole reply at once, chunked here into text_delta events). The answer is
//      markdown with [n] markers and a trailing `CITATIONS: [...]` line that is stripped from the text
//      and validated by code against this turn's step outputs (citations.ts) -> one `citations` event.
//   3. `done` with the turn's tokens, cost (null if any model call had an unknown price), steps,
//      duration, the root trace id and mode "live".
// The full conversation history (every earlier user message and answer, with a one-line summary of the
// steps behind each answer) goes to the model on every call, so follow-ups work; citations must still
// come from this turn's steps.
//
// Money: chat has no write tool and its API clients are read-only (tools.ts). A deterministic check
// (money.ts) also catches obvious money-moving requests: the loop runs a real `list_approvals` step
// first, tells the model it cannot act, and if the answer does not point to the Approvals card a fixed
// notice (code-written) is appended.
//
// Stop: the AbortSignal reaches the model call (HTTP cancelled) and the in-flight tool (fetch_doc,
// Crustdata, Dodo requests cancelled); the step is closed with status "aborted", an `error` event
// "Stopped" marks the message, and the loop returns at once with what was produced so far.
import { z } from "zod";
import { isUsdCapExceeded } from "../llm/budget.js";
import { LlmRateLimitedError } from "../llm/limiter.js";
import { AGENT_SPAN_ATTR } from "../llm/agents.js";
import { MODEL_ENV } from "../llm/roles.js";
import { AGENTS } from "../schema/agents.js";
import type { CompleteResult, LlmLike, LlmMessage } from "../llm/client.js";
import { ChatToolNameSchema } from "../schema/chat.js";
import type { ChatEvent, ChatMessage } from "../schema/chat.js";
import { withSpan } from "../trace/index.js";
import { AnswerSplitter, validateChatCitations } from "./citations.js";
import type { TurnStep } from "./citations.js";
import { APPROVALS_PATH, MONEY_NOTICE, detectMoneyRequest } from "./money.js";
import { CHAT_TOOLS, STEP_ID_PLACEHOLDER, TOOL_TEXT_CHARS, capData, toolByName } from "./tools.js";
import type { ChatToolDef, ToolContext, ToolRun } from "./tools.js";

export const CHAT_MAX_STEPS = 8;
export const NOTE_MAX_WORDS = 20;
/** Characters of one earlier message sent back to the model as history. */
export const HISTORY_MESSAGE_CHARS = 6000;
export const ACTION_MAX_TOKENS = 500;
export const ANSWER_MAX_TOKENS = 1500;
export const STOPPED_MESSAGE = "Stopped — this answer is incomplete.";
/** The model Notary Chat runs on (AGENTS.chat.modelRole → its NOTARY_MODEL_* variable), for fix lines. */
const CHAT_MODEL = `the model ${AGENTS.chat.name} runs on (${MODEL_ENV[AGENTS.chat.modelRole!]})`;
const DOCTOR_FIX = `Check ${CHAT_MODEL} with \`pnpm notary doctor --llm\``;

export interface TurnInput {
  /** Earlier messages of the conversation, oldest first. */
  history: readonly ChatMessage[];
  content: string;
}

export interface AgentDeps {
  llm: LlmLike;
  /** Everything a tool needs except the turn's signal. */
  tools: Omit<ToolContext, "signal" | "usdSpent">;
  emit: (event: ChatEvent) => void;
  signal: AbortSignal;
  /** Root trace id of this message (carried by `done`). */
  traceId?: () => string | undefined;
  maxSteps?: number;
  clock?: () => number;
  /** Scrubs secret env values out of any text before it is emitted. */
  clean?: (s: string) => string;
  /** A fresh stream scrubber for the answer's deltas (a secret split across deltas is still caught). */
  streamClean?: () => { push: (delta: string) => string; end: () => string };
}

export interface TurnResult {
  status: "done" | "error" | "aborted";
  /** The visible answer text (what was streamed; partial when stopped). */
  content: string;
  steps: number;
  tokens: { input: number; output: number };
  costUsd: number | null;
  /** Model calls made. */
  modelCalls: number;
  citations: { total: number; invalid: number };
  moneyRequest: boolean;
  error?: string;
}

class Aborted extends Error {
  constructor() {
    super("aborted");
    this.name = "Aborted";
  }
}

class TurnError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "TurnError";
  }
}

// ------------------------------------------------------------------------------------- prompts

export function systemPrompt(): string {
  const tools = CHAT_TOOLS.map((t) => `- ${t.name} ${t.argsDoc}: ${t.description}`).join("\n");
  return [
    "You are Notary Chat, the assistant inside Notary. Notary tests what third-party APIs (Crustdata, Dodo Payments) actually do against their docs, issues certificates for verified behaviour, and holds risky money-moving actions for a human to approve.",
    "You answer questions by calling tools, which READ Notary's real records and, when connected, live read-only APIs. Use only what the tools return; never invent ids, numbers, names or results.",
    `You cannot move money or change anything: you cannot refund, approve, reject, charge, change plans, credit wallets or start runs, and no tool for that exists. If asked to, do not pretend; explain what would happen and that a person approves or rejects held actions on the Approvals card (${APPROVALS_PATH}) in the Notary app.`,
    "",
    "TOOLS:",
    tools,
    "",
    "PROTOCOL (until told to write the answer): reply with exactly ONE JSON object and nothing else, either",
    '  {"note": "<what you will do next, at most 20 words>", "tool": "<tool name>", "args": {<arguments>}}',
    "or, when you have what you need (or nothing needs looking up):",
    '  {"note": "<optional, at most 20 words>", "final": true}',
    `At most ${CHAT_MAX_STEPS} tool calls per question. Prefer the most specific tool. If a tool is unavailable or fails, you could not check that; do not retry it with the same arguments.`,
  ].join("\n");
}

export function finalInstructions(moneyRequest: boolean): string {
  return [
    "Now write the final answer for the user. Do NOT reply with a JSON action this time.",
    "Write concise GitHub-flavored markdown. Rules:",
    "- Put a citation marker like [1] after every factual claim. Cite only the step results of THIS question shown above (not earlier answers).",
    "- If something could not be checked (a tool was unavailable or failed), say so plainly. Never guess or fill gaps.",
    ...(moneyRequest ? [`- The user asked you to move money or change something. Say clearly that you cannot, what would happen, and that a person approves or rejects held actions on the Approvals card (${APPROVALS_PATH}).`] : []),
    "After the answer, on its own last line, write CITATIONS: followed by a JSON array with one entry per marker:",
    'CITATIONS: [{"n": 1, "type": "<certificate|run_event|run|approval|doc|api_response>", "id": "<exact id>", "stepId": "<step id, e.g. s2>"}]',
    'Ids: certificate = the cert-… or rev-… id; run_event = "<runId>#<seq>"; run = the run id; approval = the appr-… id; doc = the page URL; api_response = the step id (e.g. "s3") whose result you used.',
    "If you cite nothing, write CITATIONS: []",
  ].join("\n");
}

function stepsSummary(events: readonly ChatEvent[] | undefined): string {
  if (!events) return "";
  const started = new Map<string, { tool: string; input: string }>();
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "step_started") started.set(e.id, { tool: e.tool, input: e.input });
    if (e.type === "step_finished") {
      const s = started.get(e.id);
      if (s) lines.push(`${e.id} ${s.tool}(${s.input}) → ${e.status}: ${e.output}`);
    }
  }
  return lines.length ? `\n\n(Steps behind this answer, for context only — not citable now: ${lines.join("; ")})` : "";
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Earlier messages as model history (each assistant answer with its step summary). */
export function historyMessages(history: readonly ChatMessage[]): LlmMessage[] {
  return history.map((m) =>
    m.role === "user"
      ? { role: "user" as const, content: clip(m.content, HISTORY_MESSAGE_CHARS) }
      : { role: "assistant" as const, content: clip(`${m.content.trim() || "(no answer)"}${stepsSummary(m.events)}`, HISTORY_MESSAGE_CHARS) },
  );
}

/** Providers need user/assistant alternation starting with a user turn: merge neighbours, drop a leading assistant, no empty content. */
export function alternate(msgs: readonly LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of msgs) {
    const content = m.content.trim() ? m.content : "(empty)";
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0]!.role === "assistant") out.shift();
  return out;
}

// ------------------------------------------------------------------------------------- actions

const ActionSchema = z.union([
  z.object({ note: z.string().optional(), tool: ChatToolNameSchema, args: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ note: z.string().optional(), final: z.literal(true) }).strict(),
]);

export type ParsedAction =
  | { ok: true; kind: "tool"; note?: string; def: ChatToolDef; args: Record<string, unknown> }
  | { ok: true; kind: "final"; note?: string }
  | { ok: false; reason: string };

/** Parse one action reply: one JSON object (a code fence or surrounding prose tolerated), then zod. */
export function parseAction(text: string): ParsedAction {
  let body = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fence) body = fence[1]!.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, reason: "the reply contains no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "the reply is not valid JSON" };
  }
  const parsed = ActionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `the JSON does not match the protocol (${issue ? `${issue.path.join(".") || "object"}: ${issue.message}` : "invalid"}); tools: ${ChatToolNameSchema.options.join(", ")}` };
  }
  const a = parsed.data;
  const note = a.note?.trim() ? a.note.trim() : undefined;
  if ("final" in a) return { ok: true, kind: "final", ...(note ? { note } : {}) };
  const def = toolByName(a.tool)!;
  const args = def.args.safeParse(a.args ?? {});
  if (!args.success) {
    const issue = args.error.issues[0];
    return { ok: false, reason: `bad arguments for ${a.tool} (${issue ? `${issue.path.join(".") || "args"}: ${issue.message}` : "invalid"}); expected ${def.argsDoc}` };
  }
  return { ok: true, kind: "tool", ...(note ? { note } : {}), def, args: args.data };
}

/** ≤ NOTE_MAX_WORDS words and ≤ 200 chars. */
export function shortNote(note: string): string {
  const w = note.replace(/\s+/g, " ").trim().split(" ");
  let s = w.length > NOTE_MAX_WORDS ? `${w.slice(0, NOTE_MAX_WORDS).join(" ")}…` : w.join(" ");
  if (s.length > 200) s = `${s.slice(0, 199)}…`;
  return s;
}

/** Split a long delta into word-boundary chunks so non-streaming providers still render progressively. */
export function chunkText(text: string, size = 48): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(" ", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

// ------------------------------------------------------------------------------------ the loop

export async function runTurn(input: TurnInput, deps: AgentDeps): Promise<TurnResult> {
  const clock = deps.clock ?? (() => performance.now());
  const clean = deps.clean ?? ((s: string) => s);
  const maxSteps = deps.maxSteps ?? CHAT_MAX_STEPS;
  const t0 = clock();
  const { signal } = deps;
  const steps: (TurnStep & { tool: string; key: string })[] = [];
  const usage = { input: 0, output: 0, usd: 0, unknown: false, calls: 0 };
  const money = detectMoneyRequest(input.content);
  let visible = "";
  let citations = { total: 0, invalid: 0 };

  const emit = (e: ChatEvent): void => deps.emit(e);
  const emitText = (t: string): void => {
    for (const piece of chunkText(t)) emit({ type: "text_delta", text: piece });
  };
  const result = (status: TurnResult["status"], error?: string): TurnResult => ({
    status,
    content: visible,
    steps: steps.length,
    tokens: { input: usage.input, output: usage.output },
    costUsd: usage.unknown ? null : Math.round(usage.usd * 1e9) / 1e9,
    modelCalls: usage.calls,
    citations,
    moneyRequest: money.moneyMoving,
    ...(error ? { error } : {}),
  });

  const ctx: ToolContext = { ...deps.tools, signal, usdSpent: () => usage.usd };

  const callModel = async (messages: LlmMessage[], maxTokens: number, onText?: (d: string) => void): Promise<CompleteResult> => {
    if (signal.aborted) throw new Aborted();
    let r: CompleteResult;
    try {
      r = await deps.llm.complete({ role: AGENTS.chat.modelRole!, agent: "chat", system: systemPrompt(), messages: alternate(messages), maxTokens, signal, ...(onText ? { onText } : {}) });
    } catch (err) {
      if (signal.aborted) throw new Aborted();
      const msg = clean(err instanceof Error ? err.message : String(err));
      if (msg.startsWith("BLOCKED:")) throw new TurnError(msg, "Fix the variable named above in .env, restart `pnpm notary serve`, then run `pnpm notary doctor --llm`");
      if (isUsdCapExceeded(err)) throw new TurnError(msg, "Raise NOTARY_MAX_USD in .env (or unset it), then restart `pnpm notary serve`");
      if (err instanceof LlmRateLimitedError) throw new TurnError(msg, "Wait a minute and ask again, or raise NOTARY_LLM_RPM / NOTARY_LLM_CONCURRENCY in .env; `pnpm notary doctor --llm` shows the limits");
      throw new TurnError(`${AGENTS.chat.name}'s model call failed: ${msg}`, DOCTOR_FIX);
    }
    usage.calls += 1;
    usage.input += r.inputTokens;
    usage.output += r.outputTokens;
    usage.usd += r.usd;
    if (r.priceSource === "unknown") usage.unknown = true;
    if (signal.aborted) throw new Aborted();
    return r;
  };

  const runStep = async (def: ChatToolDef, args: Record<string, unknown>): Promise<string> => {
    const id = `s${steps.length + 1}`;
    const inputSummary = clean(def.input(args));
    emit({ type: "step_started", id, tool: def.name, title: clean(def.title(args)), input: inputSummary });
    const started = clock();
    let run: ToolRun | "aborted" = "aborted";
    let set: (k: string, v: string | number | boolean) => void = () => {};
    // The span body returns a small summary only (the SDK records the return value); the result stays here.
    await withSpan(
      "notary.chat.tool",
      { [AGENT_SPAN_ATTR]: AGENTS.chat.name, "notary.chat.tool": def.name, "notary.chat.step_id": id, "notary.chat.input_chars": inputSummary.length },
      async () => {
        try {
          run = await def.run(args, ctx);
        } catch (err) {
          if (signal.aborted) run = "aborted";
          else {
            const msg = clean(err instanceof Error ? err.message : String(err));
            run = { status: "error", output: clip(`Failed: ${msg}`, 200), modelText: `ERROR: the tool failed (${clip(msg, 300)}). Nothing was learned from this step.`, citables: [] };
          }
        }
        if (signal.aborted) run = "aborted";
        const r = run as ToolRun | "aborted";
        set("notary.chat.status", r === "aborted" ? "aborted" : r.status);
        set("notary.chat.duration_ms", Math.max(0, Math.round(clock() - started)));
        if (r !== "aborted") {
          set("notary.chat.citables", r.citables.length);
          if (r.credits !== undefined) set("notary.chat.credits", r.credits);
        }
        return { status: r === "aborted" ? "aborted" : r.status };
      },
      { kind: "TOOL", onSpan: (_ids, setter) => (set = setter) },
    );
    const durationMs = Math.max(0, Math.round(clock() - started));
    if (run === "aborted") {
      emit({ type: "step_finished", id, status: "aborted", durationMs, costUsd: null, output: "Stopped by the user" });
      steps.push({ id, status: "aborted", citables: [], tool: def.name, key: "" });
      throw new Aborted();
    }
    run = run as ToolRun;
    const citables = run.citables.map((c) => (c.id === STEP_ID_PLACEHOLDER ? { ...c, id } : c));
    const data = capData(run.data);
    emit({
      type: "step_finished",
      id,
      status: run.status,
      durationMs,
      costUsd: null,
      ...(run.credits !== undefined ? { credits: run.credits } : {}),
      output: clean(run.output),
      ...(data !== undefined ? { data: JSON.parse(clean(JSON.stringify(data))) } : {}),
      ...(run.fix ? { fix: clean(run.fix) } : {}),
    });
    steps.push({ id, status: run.status, citables, tool: def.name, key: `${def.name}:${JSON.stringify(args)}` });
    const citeLine = citables.length
      ? `\nCitable from ${id}: ${citables.map((c) => `${c.type} ${c.id}`).join(", ")}`
      : run.status === "ok"
        ? `\nCitable from ${id}: api_response ${id}`
        : "";
    return clean(`Result of step ${id} (${def.name} ${inputSummary || "{}"}) — status ${run.status}:\n${clip(run.modelText, TOOL_TEXT_CHARS)}${citeLine}`);
  };
  const convo: LlmMessage[] = [...historyMessages(input.history), { role: "user", content: input.content }];

  try {
    // Deterministic: an obvious money-moving request gets a real read of what is held, and the model is told it can't act.
    if (money.moneyMoving) {
      const approvals = toolByName("list_approvals")!;
      const resultText = await runStep(approvals, {});
      convo.push({
        role: "user",
        content: `[Notary: this message asks to move money or change something ("${money.verb}"). Chat cannot do that — no tool can write. Notary ran ${steps[steps.length - 1]!.id} (list_approvals) to show what is actually held.]\n${resultText}`,
      });
    }

    // 1. Action phase.
    let iterations = 0;
    let toolSteps = 0;
    while (toolSteps < maxSteps && iterations < maxSteps + 4) {
      iterations += 1;
      let reply = await callModel(convo, ACTION_MAX_TOKENS);
      let action = parseAction(reply.text);
      if (!action.ok) {
        convo.push({ role: "assistant", content: reply.text });
        convo.push({ role: "user", content: `Your reply was not a valid action: ${action.reason}. Reply with exactly one JSON object as described in the protocol, nothing else.` });
        reply = await callModel(convo, ACTION_MAX_TOKENS);
        action = parseAction(reply.text);
        if (!action.ok) throw new TurnError(`${AGENTS.chat.name}'s reply was not a valid action twice in a row (${action.reason}).`, `Ask again or rephrase the question; if it keeps happening, check ${CHAT_MODEL} with \`pnpm notary doctor --llm\``);
      }
      convo.push({ role: "assistant", content: reply.text });
      if (action.note) emit({ type: "note", text: clean(shortNote(action.note)), source: "model" });
      if (action.kind === "final") break;
      const key = `${action.def.name}:${JSON.stringify(action.args)}`;
      const dup = steps.find((s) => s.key === key);
      if (dup) {
        convo.push({ role: "user", content: `You already ran ${action.def.name} with these arguments in step ${dup.id}; its result is above. Choose a different step or reply {"final": true}.` });
        continue;
      }
      convo.push({ role: "user", content: await runStep(action.def, action.args) });
      toolSteps += 1;
    }

    // 2. Answer phase (streamed).
    convo.push({ role: "user", content: finalInstructions(money.moneyMoving) });
    const splitter = new AnswerSplitter();
    // Secret-safe across deltas (a second line of defence behind LlmClient's own stream scrubbing),
    // and trailing whitespace before the CITATIONS line is never emitted.
    const safe = deps.streamClean?.() ?? { push: (d: string) => clean(d), end: () => "" };
    let pendingWs = "";
    const show = (out: string): void => {
      if (!out) return;
      const text = pendingWs + out;
      const trimmed = text.replace(/\s+$/, "");
      pendingWs = text.slice(trimmed.length);
      if (trimmed) {
        visible += trimmed;
        emitText(trimmed);
      }
    };
    const onText = (d: string): void => show(splitter.push(safe.push(d)));
    await callModel(convo, ANSWER_MAX_TOKENS, onText);
    show(splitter.push(safe.end()));
    show(splitter.end().text);
    const block = splitter.block;
    if (!visible.trim()) throw new TurnError(`${AGENTS.chat.name} returned an empty answer.`, DOCTOR_FIX);
    if (money.moneyMoving && !visible.includes(APPROVALS_PATH)) {
      const notice = `\n\n${MONEY_NOTICE}`;
      visible += notice;
      emitText(notice);
    }
    const checked = validateChatCitations(visible, block, steps);
    citations = { total: checked.items.length, invalid: checked.invalid };
    emit({ type: "citations", items: checked.items.map((c) => ({ ...c, label: clean(c.label) })) });
    const traceId = deps.traceId?.();
    const r = result("done");
    emit({
      type: "done",
      costUsd: r.costUsd,
      tokens: r.tokens,
      ...(traceId ? { traceId } : {}),
      steps: r.steps,
      durationMs: Math.max(0, Math.round(clock() - t0)),
      mode: "live",
    });
    return r;
  } catch (err) {
    if (err instanceof Aborted || signal.aborted) {
      emit({ type: "error", message: STOPPED_MESSAGE });
      return result("aborted", "stopped by the user");
    }
    if (err instanceof TurnError) {
      emit({ type: "error", message: clean(err.message), ...(err.fix ? { fix: clean(err.fix) } : {}) });
      return result("error", clean(err.message));
    }
    const msg = clean(err instanceof Error ? err.message : String(err));
    emit({ type: "error", message: `Chat failed: ${msg}`, fix: "See the `notary serve` terminal" });
    return result("error", msg);
  }
}
