/**
 * Model roster: one Bedrock model id per role, read from env (TDD "Integrations: AWS Bedrock").
 *
 *   NOTARY_MODEL_EXECUTOR   cheap, fast
 *   NOTARY_MODEL_REFLECTOR  proposes hypotheses
 *   NOTARY_MODEL_ADVERSARY  reviews beliefs; must differ from the reflector (separation of duties)
 *
 * A missing id is not an error until that role is used: `requireModel` then throws the usual
 * BLOCKED error ("BLOCKED: NOTARY_MODEL_REFLECTOR not set — set it in .env (see .env.example) and
 * run `pnpm notary doctor --llm`"). A roster where reflector and adversary name the same model is
 * invalid config and is rejected as soon as it is resolved.
 *
 * Notary Chat is a fourth model role outside the bundle's three (the frozen bundle schema's
 * `usageByRole` keeps executor / reflector / adversary): NOTARY_MODEL_CHAT, falling back to
 * NOTARY_MODEL_REFLECTOR when unset. The Adversary's model is never a fallback.
 */
import type { Role } from "../schema/index.js";
import { MissingCredentialError } from "../tools/errors.js";
import { AGENTS } from "../schema/agents.js";

export const ROLES: readonly Role[] = ["executor", "reflector", "adversary"];

export const MODEL_ENV: Record<Role, string> = {
  executor: "NOTARY_MODEL_EXECUTOR",
  reflector: "NOTARY_MODEL_REFLECTOR",
  adversary: "NOTARY_MODEL_ADVERSARY",
};

export type ModelRoster = Record<Role, string | undefined>;

/** Every model role the LLM layer serves: the bundle's three plus Notary Chat. */
export type ModelRole = Role | "chat";

export const CHAT_MODEL_ENV = "NOTARY_MODEL_CHAT";
/** The variable Notary Chat falls back to when NOTARY_MODEL_CHAT is unset. */
export const CHAT_MODEL_FALLBACK_ENV = "NOTARY_MODEL_REFLECTOR";

/** Where the chat model id came from. */
export type ChatModelSource = typeof CHAT_MODEL_ENV | typeof CHAT_MODEL_FALLBACK_ENV;

/** Notary Chat's model: NOTARY_MODEL_CHAT, else NOTARY_MODEL_REFLECTOR, else null. Never throws. */
export function resolveChatModel(env: Record<string, string | undefined> = process.env): { model: string; source: ChatModelSource } | null {
  const own = (env[CHAT_MODEL_ENV] ?? "").trim();
  if (own) return { model: own, source: CHAT_MODEL_ENV };
  const fb = (env[CHAT_MODEL_FALLBACK_ENV] ?? "").trim();
  if (fb) return { model: fb, source: CHAT_MODEL_FALLBACK_ENV };
  return null;
}

/** The env variable that names a model role's model (chat: NOTARY_MODEL_CHAT; its fallback is NOTARY_MODEL_REFLECTOR). */
export function modelEnvFor(role: ModelRole): string {
  return role === "chat" ? CHAT_MODEL_ENV : MODEL_ENV[role];
}

/** The model id for any model role (chat via resolveChatModel), or the BLOCKED error naming the variable. */
export function requireRoleModel(env: Record<string, string | undefined>, roster: ModelRoster, role: ModelRole): string {
  if (role !== "chat") return requireModel(roster, role);
  const c = resolveChatModel(env);
  if (!c) throw new MissingCredentialError(CHAT_MODEL_ENV, `${LLM_FIX_HINT} (or set ${CHAT_MODEL_FALLBACK_ENV}, which Notary Chat falls back to)`);
  return c.model;
}

/** What to do about a missing / invalid model setting; appended to every LLM BLOCKED message. */
export const LLM_FIX_HINT = "set it in .env (see .env.example) and run `pnpm notary doctor --llm`";

type Env = Record<string, string | undefined>;

/** Config that can never be valid (as opposed to merely incomplete, which is BLOCKED). */
export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

function read(env: Env, name: string): string | undefined {
  const v = (env[name] ?? "").trim();
  return v.length ? v : undefined;
}

/**
 * Normalise a model id for the separation-of-duties comparison: a cross-region inference profile
 * ("us.anthropic.claude-…") runs the same model as the bare id, so the geo prefix is ignored.
 */
export function baseModelId(modelId: string): string {
  return modelId.trim().replace(/^(us|eu|apac|global|jp|au|ca|us-gov)\./i, "").toLowerCase();
}

export function resolveModels(env: Env = process.env): ModelRoster {
  const roster: ModelRoster = {
    executor: read(env, MODEL_ENV.executor),
    reflector: read(env, MODEL_ENV.reflector),
    adversary: read(env, MODEL_ENV.adversary),
  };
  if (roster.reflector && roster.adversary && baseModelId(roster.reflector) === baseModelId(roster.adversary)) {
    throw new ModelConfigError(
      `Separation of duties: the ${AGENTS.reflector.name} (${MODEL_ENV.reflector}) and the ${AGENTS.adversary.name} (${MODEL_ENV.adversary}) must run on different models ` +
        `(both are "${roster.reflector}"). The model that proposes a belief may never review it. ` +
        `Set ${MODEL_ENV.adversary} to a different model and run \`pnpm notary doctor --llm\`.`,
    );
  }
  return roster;
}

/** The model id for `role`, or the BLOCKED error naming the env var to set. */
export function requireModel(roster: ModelRoster, role: Role): string {
  const id = roster[role];
  if (!id) throw new MissingCredentialError(MODEL_ENV[role], LLM_FIX_HINT);
  return id;
}
