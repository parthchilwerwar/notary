// The Notary Chat agent: one user message -> a native tool-calling loop -> one cited answer.
//
// A real agent loop over OpenAI-style function tools (LlmClient.completeTools: LiteLLM `tools` /
// `tool_choice` with `tool_calls` fed back as `tool` messages; Bedrock Converse toolUse/toolResult).
// Model role "chat" (NOTARY_MODEL_CHAT, falling back to NOTARY_MODEL_REFLECTOR); system prompt from
// src/agents/prompts.ts (chatSystemPrompt).
//
//   1. Every model call offers every chat tool (chatToolSpecs: JSON Schema generated from the zod
//      schema that validates the arguments). A reply with tool calls is executed by code: each call's
//      name and arguments are validated (zod); a valid, new call runs as one step (step_started ->
//      step_finished on the SSE stream, wrapped in a TOOL span) and its result goes back as the
//      `tool` message for that call id; an invalid or repeated call gets an explanatory `tool` result
//      and no step. Text the model writes next to its tool calls becomes a `note` event (≤ 20 words).
//   2. A reply without tool calls is the answer. At most `maxSteps` (8) tool steps per question; when
//      the cap is reached the next call uses tool_choice "none" with a nudge to answer now.
//      Two consecutive rounds with only invalid calls end the turn with an `error` event.
//   3. The answer is markdown with [n] markers and a trailing `CITATIONS: [...]` line, which is
//      stripped from the text and validated by code against this turn's step outputs only
//      (citations.ts: every cited id must be a record id a tool returned this turn) -> one
//      `citations` event; then `done` with tokens, cost (null when a price is unknown), steps,
//      duration, the root trace id and mode "live". The answer text is emitted once the model's
//      final reply is complete (a reply only turns out to be the answer when it carries no tool
//      call), in small text_delta chunks.
// History: earlier user messages and answers (each answer with a one-line summary of its steps) are
// sent as plain user/assistant turns; citations must still come from this turn's steps.
//
// Budget: one LlmClient per message, so NOTARY_MAX_USD caps one message's model spend (checked before
// every call); NOTARY_LLM_RPM / NOTARY_LLM_CONCURRENCY apply to every call; messages per minute are
// limited by NOTARY_ASK_RPM in api/chat.ts.
//
// Money: no tool can write and the API clients are read-only (tools.ts). A deterministic check
// (money.ts) also catches obvious money-moving requests: a real list_approvals step runs first, the
// model is told it cannot act, and if the answer does not point to the Approvals card a fixed notice
// (written by code) is appended. Chat never approves or executes anything.
//
// Tracing: the loop runs in one AGENT span `notary.chat.agent`; each tool call is a TOOL span
// `notary.chat.tool` (notary.tool, notary.recordIds = the record ids it returned); model calls open
// their own spans in LlmClient. No prompt, message text, token or secret in attributes.
//
// Stop: the AbortSignal reaches the model call (HTTP cancelled) and the in-flight tool; the step is
// closed with status "aborted", an `error` event "Stopped" marks the message and the loop returns.
import { chatStepCapNudge, chatSystemPrompt, CHAT_DEFAULT_MAX_STEPS, CHAT_NOTE_MAX_WORDS } from "../agents/prompts.js";
import { isUsdCapExceeded } from "../llm/budget.js";
import { LlmRateLimitedError } from "../llm/limiter.js";
import { AGENT_SPAN_ATTR } from "../llm/agents.js";
import { CHAT_MODEL_ENV, CHAT_MODEL_FALLBACK_ENV } from "../llm/roles.js";
import { AGENTS } from "../schema/agents.js";
import type { AgentMessage, ToolCall, ToolChoice, ToolCompleteResult, ToolLlmLike } from "../llm/client.js";
import type { ChatEvent, ChatMessage } from "../schema/chat.js";
import { withSpan } from "../trace/index.js";
import { AnswerSplitter, validateChatCitations } from "./citations.js";
import type { TurnStep } from "./citations.js";
import { APPROVALS_PATH, MONEY_NOTICE, detectMoneyRequest } from "./money.js";
import { CHAT_TOOLS, STEP_ID_PLACEHOLDER, TOOL_TEXT_CHARS, capData, chatToolSpecs, toolByName } from "./tools.js";
import type { ChatToolDef, ToolContext, ToolRun } from "./tools.js";

export const CHAT_MAX_STEPS = CHAT_DEFAULT_MAX_STEPS;
export const NOTE_MAX_WORDS = CHAT_NOTE_MAX_WORDS;
/** Characters of one earlier message sent back to the model as history. */
export const HISTORY_MESSAGE_CHARS = 6000;
/** Output cap per model call (a call may turn out to be the answer). */
export const CALL_MAX_TOKENS = 1500;
/** Rounds in a row whose tool calls were all invalid before the turn gives up. */
export const MAX_INVALID_ROUNDS = 2;
export const STOPPED_MESSAGE = "Stopped — this answer is incomplete.";
/** Span attribute: the agent's id (src/schema/agents.ts), next to the display name in notary.agent. */
export const AGENT_ID_SPAN_ATTR = "notary.agent_id";
/** The model Notary Chat runs on, for fix lines. */
const CHAT_MODEL = `the model ${AGENTS.chat.name} runs on (${CHAT_MODEL_ENV}, else ${CHAT_MODEL_FALLBACK_ENV})`;
const DOCTOR_FIX = `Check ${CHAT_MODEL} with \`pnpm notary doctor --llm\``;

export interface TurnInput {
  /** Earlier messages of the conversation, oldest first. */
  history: readonly ChatMessage[];
  content: string;
}

export interface AgentDeps {
  llm: ToolLlmLike;
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
  /** A fresh stream scrubber for the answer's text (a secret split across chunks is still caught). */
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

/** Notary Chat's system prompt (src/agents/prompts.ts). */
export function systemPrompt(maxSteps: number = CHAT_MAX_STEPS): string {
  return chatSystemPrompt({ maxSteps });
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
export function historyMessages(history: readonly ChatMessage[]): AgentMessage[] {
  return history.map((m) =>
    m.role === "user"
      ? { role: "user" as const, content: clip(m.content, HISTORY_MESSAGE_CHARS) }
      : { role: "assistant" as const, content: clip(`${m.content.trim() || "(no answer)"}${stepsSummary(m.events)}`, HISTORY_MESSAGE_CHARS) },
  );
}

// ---------------------------------------------------------------------------------- tool calls

export type CheckedCall = { ok: true; def: ChatToolDef; args: Record<string, unknown> } | { ok: false; reason: string };

/** Validate one native tool call: a known tool and arguments that pass its zod schema. */
export function checkToolCall(call: Pick<ToolCall, "name" | "arguments">): CheckedCall {
  const def = toolByName(call.name);
  if (!def) return { ok: false, reason: `there is no tool named "${call.name}"; the tools are ${CHAT_TOOLS.map((t) => t.name).join(", ")}` };
  let raw: unknown = {};
  const text = call.arguments.trim();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, reason: `the arguments for ${def.name} are not valid JSON` };
    }
  }
  const args = def.args.safeParse(raw ?? {});
  if (!args.success) {
    const issue = args.error.issues[0];
    return { ok: false, reason: `bad arguments for ${def.name} (${issue ? `${issue.path.join(".") || "args"}: ${issue.message}` : "invalid"}); expected ${def.argsDoc}` };
  }
  return { ok: true, def, args: args.data };
}

/** ≤ NOTE_MAX_WORDS words and ≤ 200 chars. */
export function shortNote(note: string): string {
  const w = note.replace(/\s+/g, " ").trim().split(" ");
  let s = w.length > NOTE_MAX_WORDS ? `${w.slice(0, NOTE_MAX_WORDS).join(" ")}…` : w.join(" ");
  if (s.length > 200) s = `${s.slice(0, 199)}…`;
  return s;
}

/** Split a long text into word-boundary chunks so the answer still renders progressively. */
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
  let agentSet: (k: string, v: string | number | boolean) => void = () => {};
  const result = await withSpan(
    "notary.chat.agent",
    { [AGENT_SPAN_ATTR]: AGENTS.chat.name, [AGENT_ID_SPAN_ATTR]: "chat", "notary.chat.history_messages": input.history.length },
    async () => {
      const r = await loop(input, deps);
      agentSet("notary.chat.status", r.status);
      agentSet("notary.chat.steps", r.steps);
      agentSet("notary.chat.model_calls", r.modelCalls);
      agentSet("notary.chat.citations", r.citations.total);
      agentSet("notary.chat.citations_invalid", r.citations.invalid);
      return r;
    },
    { kind: "AGENT", onSpan: (_ids, set) => (agentSet = set) },
  );
  return result;
}

async function loop(input: TurnInput, deps: AgentDeps): Promise<TurnResult> {
  const clock = deps.clock ?? (() => performance.now());
  const clean = deps.clean ?? ((s: string) => s);
  const maxSteps = deps.maxSteps ?? CHAT_MAX_STEPS;
  const t0 = clock();
  const { signal } = deps;
  const steps: (TurnStep & { tool: string; key: string })[] = [];
  const usage = { input: 0, output: 0, usd: 0, unknown: false, calls: 0 };
  const money = detectMoneyRequest(input.content);
  const system = systemPrompt(maxSteps);
  const specs = chatToolSpecs();
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

  const callModel = async (messages: AgentMessage[], toolChoice: ToolChoice): Promise<ToolCompleteResult> => {
    if (signal.aborted) throw new Aborted();
    let r: ToolCompleteResult;
    try {
      r = await deps.llm.completeTools({ role: "chat", agent: "chat", system, messages, tools: specs, toolChoice, maxTokens: CALL_MAX_TOKENS, signal });
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

  /** Run one validated tool call as a step; returns the text the model gets back as the tool result. */
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
      {
        [AGENT_SPAN_ATTR]: AGENTS.chat.name,
        [AGENT_ID_SPAN_ATTR]: "chat",
        "notary.tool": def.name,
        "notary.chat.tool": def.name,
        "notary.chat.step_id": id,
        "notary.chat.input_chars": inputSummary.length,
      },
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
          // Record ids only (never record content); the step id stands in for an API response.
          set("notary.recordIds", clip(r.citables.map((c) => (c.id === STEP_ID_PLACEHOLDER ? id : c.id)).join(","), 1000));
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

  const convo: AgentMessage[] = [...historyMessages(input.history), { role: "user", content: input.content }];

  try {
    // Deterministic: an obvious money-moving request gets a real read of what is held, and the model is told it can't act.
    if (money.moneyMoving) {
      const resultText = await runStep(toolByName("list_approvals")!, {});
      convo.push({
        role: "user",
        content: `[Notary: this message asks to move money or change something ("${money.verb}"). Chat cannot do that — no tool can write. Notary ran ${steps[steps.length - 1]!.id} (list_approvals) to show what is actually held. Answer any other part of the question with your tools as usual.]\n${resultText}`,
      });
    }

    // The agent loop: the model calls tools until it answers (or the step cap forces an answer).
    let answer: string | null = null;
    let invalidRounds = 0;
    let capped = false;
    while (answer === null) {
      const toolSteps = steps.length - (money.moneyMoving ? 1 : 0);
      if (!capped && toolSteps >= maxSteps) {
        capped = true;
        convo.push({ role: "user", content: chatStepCapNudge(maxSteps) });
      }
      const reply = await callModel(convo, capped ? "none" : "auto");
      if (!reply.toolCalls.length || capped) {
        answer = reply.text;
        break;
      }
      // The model's words next to its calls are its note (≤ 20 words).
      if (reply.text.trim()) emit({ type: "note", text: clean(shortNote(reply.text)), source: "model" });
      // Ids must be unique per call for the provider to pair results; fill any the provider left empty.
      const calls = reply.toolCalls.map((c, i) => ({ ...c, id: c.id || `call_${usage.calls}_${i}` }));
      convo.push({ role: "assistant", content: reply.text, toolCalls: calls });
      let validThisRound = 0;
      for (const call of calls) {
        let out: string;
        const checked = checkToolCall(call);
        if (!checked.ok) out = `Not run: ${checked.reason}. Fix the call or answer from what you have.`;
        else {
          validThisRound += 1;
          const key = `${checked.def.name}:${JSON.stringify(checked.args)}`;
          const dup = steps.find((s) => s.key === key);
          if (dup) out = `Not run again: you already ran ${checked.def.name} with these arguments in step ${dup.id}; its result is above.`;
          else if (steps.length - (money.moneyMoving ? 1 : 0) >= maxSteps) out = `Not run: the limit of ${maxSteps} tool calls for this question is reached.`;
          else out = await runStep(checked.def, checked.args);
        }
        // Every tool call gets exactly one tool result (providers require the pairing).
        convo.push({ role: "tool", toolCallId: call.id, name: call.name, content: out });
      }
      invalidRounds = validThisRound === 0 ? invalidRounds + 1 : 0;
      if (invalidRounds >= MAX_INVALID_ROUNDS) {
        throw new TurnError(`${AGENTS.chat.name}'s tool calls were invalid ${MAX_INVALID_ROUNDS} rounds in a row.`, `Ask again or rephrase the question; if it keeps happening, check ${CHAT_MODEL} with \`pnpm notary doctor --llm\``);
      }
    }

    // The answer: strip and check the CITATIONS line, scrub secrets, emit in chunks.
    const splitter = new AnswerSplitter();
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
    show(splitter.push(safe.push(answer)));
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
