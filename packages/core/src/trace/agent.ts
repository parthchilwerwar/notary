/**
 * Agent monitoring in neatlogs: every agent run is one AGENT span.
 *
 *   notary.agent.<id>   kind AGENT
 *     notary.agent      display name ("Executor", "Reflector", "Adversary", "Notary Chat"); P2 name
 *     notary.agent_id   executor | reflector | adversary | chat
 *     notary.role       the model role it runs on (executor | reflector | adversary | chat)
 *     notary.model      the configured model id (NOTARY_MODEL_*), when set
 *     + the caller's ids (notary.claimId, notary.beliefId, notary.decisionId, ...)
 *
 * Inside it, each model call is the `notary.llm` CHAIN (role, tokens, USD, latency, stop reason)
 * whose child is the SDK's LLM span from wrapOpenAI (LiteLLM) / wrapBedrock (Bedrock); tool calls
 * are `notary.tool.call` TOOL spans; guard decisions are GUARDRAIL spans; verdicts are EVALUATOR
 * spans. Pass-through when tracing is off (the span still goes to the local spans.jsonl sink).
 */
import { AGENTS } from "../schema/agents.js";
import type { AgentId } from "../schema/agents.js";
import { agentModels } from "../llm/agents.js";
import { withSpan } from "./index.js";
import type { SpanIds, TraceAttrs } from "./index.js";

export type ModelAgent = Exclude<AgentId, "guard">;

export const AGENT_ID_ATTR = "notary.agent_id";

/** The AGENT span attributes for `agent` (model id from config, never hardcoded). */
export function agentAttrs(agent: ModelAgent, env: Record<string, string | undefined> = process.env): TraceAttrs {
  const info = AGENTS[agent];
  let model: string | null = null;
  try {
    model = agentModels(env)[agent];
  } catch {
    model = null;
  }
  return {
    "notary.agent": info.name,
    [AGENT_ID_ATTR]: agent,
    "notary.role": info.modelRole ?? agent,
    ...(model ? { "notary.model": model } : {}),
  };
}

/**
 * Run `fn` as one run of `agent`: an AGENT span named `notary.agent.<id>`. Errors are recorded on
 * the span and rethrown. `onSpan` receives the ids and a setter for attributes known later (e.g. the
 * verdict). The span's output is whatever `fn` returns, so return small summaries, never secrets.
 */
export function withAgent<T>(
  agent: ModelAgent,
  attrs: TraceAttrs,
  fn: () => Promise<T> | T,
  opts: { onSpan?: (ids: SpanIds, set: (key: string, value: string | number | boolean) => void) => void } = {},
): Promise<T> {
  return withSpan(`notary.agent.${agent}`, { ...agentAttrs(agent), ...attrs }, fn, { kind: "AGENT", ...(opts.onSpan ? { onSpan: opts.onSpan } : {}) });
}
