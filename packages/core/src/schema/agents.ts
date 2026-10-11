// P2: the one source of truth for agent names. Browser-safe (zod only) so packages/web renders the
// same names. Display names and roles live here; the MODEL each agent uses is never hardcoded — it
// comes from config at runtime (core: NOTARY_MODEL_* via src/llm/roles.ts; web: from data such as
// bundle usage, adversary reviews or /api/health) and is attached with `agentModel()` when known.
import { z } from "zod";

export const AgentIdSchema = z.enum(["executor", "reflector", "adversary", "chat", "guard"]);

export type AgentId = z.infer<typeof AgentIdSchema>;

export type AgentInfo = {
  id: AgentId;
  /** Exact display name; use it verbatim in every user-facing string and span name. */
  name: string;
  /** One-line role. */
  role: string;
  /** "model" = an LLM role; "rule" = deterministic code, never called an agent in UI copy. */
  kind: "model" | "rule";
  /** Which configured model role it runs on (null for rules). Chat runs on the executor model. */
  modelRole: "executor" | "reflector" | "adversary" | null;
};

export const AGENTS: Readonly<Record<AgentId, AgentInfo>> = {
  executor: {
    id: "executor",
    name: "Executor",
    role: "Works the billing queue and calls the tools",
    kind: "model",
    modelRole: "executor",
  },
  reflector: {
    id: "reflector",
    name: "Reflector",
    role: "Proposes explanations when results don't match predictions",
    kind: "model",
    modelRole: "reflector",
  },
  adversary: {
    id: "adversary",
    name: "Adversary",
    role: "The stronger model that tries to refute every claim",
    kind: "model",
    modelRole: "adversary",
  },
  chat: {
    id: "chat",
    name: "Notary Chat",
    role: "Answers questions about runs, certificates and APIs",
    kind: "model",
    modelRole: "executor",
  },
  guard: {
    id: "guard",
    name: "Guard",
    role: "The deterministic check that blocks money moves without a certificate",
    kind: "rule",
    modelRole: null,
  },
};

export const AGENT_ORDER: readonly AgentId[] = ["executor", "reflector", "adversary", "chat", "guard"];

/** The agent badge label, optionally with the configured model id ("Adversary · claude-sonnet-4.6"). */
export function agentLabel(id: AgentId, model?: string | null): string {
  const a = AGENTS[id];
  return model && a.kind === "model" ? `${a.name} · ${model}` : a.name;
}

/** Badge kind text for rules ("rule") vs agents — rules are never labelled as agents. */
export function agentKindLabel(id: AgentId): "agent" | "rule" {
  return AGENTS[id].kind === "rule" ? "rule" : "agent";
}
