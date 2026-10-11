/**
 * P2 agent names, core side. The names, roles and kinds live in src/schema/agents.ts (browser-safe,
 * the one source of truth); this module attaches the MODEL each agent runs on, read from config
 * (NOTARY_MODEL_* via resolveModels) and never hardcoded. Notary Chat runs on the executor model
 * (AGENTS.chat.modelRole); the Guard is a deterministic rule and has no model.
 *
 * `agentModels(env)` never throws: a roster that breaks separation of duties (reflector = adversary)
 * still reports the configured ids, because they ARE the config; `notary doctor --llm` and
 * GET /api/health report the breach itself.
 */
import { AGENTS, AGENT_ORDER } from "../schema/agents.js";
import type { AgentId, AgentInfo } from "../schema/agents.js";
import type { Role } from "../schema/index.js";
import { MODEL_ENV, ModelConfigError, ROLES, resolveModels } from "./roles.js";
import type { ModelRoster } from "./roles.js";

type Env = Record<string, string | undefined>;

/** Model agents only (the Guard is a rule). */
export type ModelAgentId = Exclude<AgentId, "guard">;

/** The configured model id per model agent; null when its NOTARY_MODEL_* variable is unset. */
export type AgentModels = Record<ModelAgentId, string | null>;

/** One row of GET /api/health `agents`. */
export type AgentStatus = Pick<AgentInfo, "id" | "name" | "role" | "kind"> & { model: string | null };

function roster(env: Env): ModelRoster {
  try {
    return resolveModels(env);
  } catch (err) {
    if (!(err instanceof ModelConfigError)) throw err;
    const out = {} as ModelRoster;
    for (const r of ROLES) {
      const v = (env[MODEL_ENV[r]] ?? "").trim();
      out[r] = v.length ? v : undefined;
    }
    return out;
  }
}

/** Model ids from config (NOTARY_MODEL_*), per agent; null when unset. */
export function agentModels(env: Env = process.env): AgentModels {
  const r = roster(env);
  const of = (id: ModelAgentId): string | null => {
    const role = AGENTS[id].modelRole;
    return role ? (r[role] ?? null) : null;
  };
  return { executor: of("executor"), reflector: of("reflector"), adversary: of("adversary"), chat: of("chat") };
}

/** Every agent in display order with its configured model (null for the Guard and for unset roles). */
export function agentRoster(env: Env = process.env): AgentStatus[] {
  const models = agentModels(env);
  return AGENT_ORDER.map((id) => {
    const a = AGENTS[id];
    return { id, name: a.name, role: a.role, kind: a.kind, model: id === "guard" || a.kind === "rule" ? null : models[id] };
  });
}

/** The display name of an agent ("Executor", "Notary Chat", "Guard", ...). */
export function agentName(id: AgentId): string {
  return AGENTS[id].name;
}

/** The display name of the agent that owns a model role (executor → "Executor", ...). */
export function roleAgentName(role: Role): string {
  return AGENTS[role].name;
}

/** Span attribute carrying the agent's display name (never a prompt or a secret). */
export const AGENT_SPAN_ATTR = "notary.agent";
