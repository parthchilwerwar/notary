/**
 * MODEL TEST DOUBLES for `notary demo --fixture`: a deterministic Bedrock Converse transport that
 * stands in for the reflector and the adversary models. It plugs into the REAL LlmClient (so the
 * real prompts are built, secrets are scrubbed, spans are opened and the real UsageMeter counts
 * tokens) and answers with JSON that follows each prompt's reply contract. No network, no AWS.
 * Token counts are estimated from text length (chars / 4); USD is 0 (fixture model, no cost).
 *
 * Reflector double — for every anomaly, 2–3 rival hypotheses chosen by the claim's expect rule, always
 * including an `honored` rival, each with a class/template pair the template tables can speak to
 * (no wildcard rivals). On a re-proposal it picks pairs that were not refuted.
 *
 * Adversary double — reads ONLY the evidence packet (raw probe records) and applies fixed rules:
 *   1. fewer than 2 cited probes                                   -> downgrade
 *   2. a cited probe sent the same claim parameter in treatment and control (value templates;
 *      count templates and record-varying templates such as type_edge are exempt, the same split
 *      as src/beliefs/params.ts COUNT_TEMPLATES / EXERCISE_TEMPLATES)  -> downgrade
 *   3. a silent_truncation belief whose every cited probe is a boundary_sweep that saw the
 *      over-limit request clamped to exactly the documented max: clamping is consistent with
 *      "max is 100" and no probe checked whether items were lost   -> downgrade
 *   4. a violated belief on a money write whose cited probes all used one currency
 *                                                                  -> narrow (scope: that currency)
 *   5. otherwise                                                   -> uphold
 */
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { canonicalJson } from "../bundle/hash.js";
import { COUNT_TEMPLATES, EXERCISE_TEMPLATES, requestSteps, valuesAtPath } from "../beliefs/params.js";
import { LlmClient } from "../llm/index.js";
import type { ConverseTransport } from "../llm/index.js";
import type { DefectClass, ProbeTemplate } from "../schema/index.js";

export const FIXTURE_MODELS = {
  executor: "fixture.executor-double",
  reflector: "fixture.reflector-double",
  adversary: "fixture.adversary-double",
} as const;

export const FIXTURE_MODEL_LABEL = "fixture model, no cost";

/** Environment for the real LlmClient: fixture model ids and zero prices (usd = 0, price source "env"). */
export function fixtureLlmEnv(): Record<string, string> {
  return {
    NOTARY_MODEL_EXECUTOR: FIXTURE_MODELS.executor,
    NOTARY_MODEL_REFLECTOR: FIXTURE_MODELS.reflector,
    NOTARY_MODEL_ADVERSARY: FIXTURE_MODELS.adversary,
    NOTARY_PRICE_EXECUTOR_IN: "0",
    NOTARY_PRICE_EXECUTOR_OUT: "0",
    NOTARY_PRICE_REFLECTOR_IN: "0",
    NOTARY_PRICE_REFLECTOR_OUT: "0",
    NOTARY_PRICE_ADVERSARY_IN: "0",
    NOTARY_PRICE_ADVERSARY_OUT: "0",
  };
}

/** A real LlmClient whose transport is the fixture double. */
export function createFixtureLlm(): LlmClient {
  return new LlmClient({ env: fixtureLlmEnv(), transport: fixtureConverseTransport() });
}

const tokens = (text: string): number => Math.ceil(text.length / 4);

export function fixtureConverseTransport(): ConverseTransport {
  return async (input: ConverseCommandInput): Promise<ConverseCommandOutput> => {
    const system = (input.system ?? []).map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("\n");
    const user = (input.messages ?? [])
      .flatMap((m) => m.content ?? [])
      .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
      .join("\n");
    let text: string;
    if (input.modelId === FIXTURE_MODELS.reflector) text = reflectorReply(user);
    else if (input.modelId === FIXTURE_MODELS.adversary) text = adversaryReply(user);
    else text = JSON.stringify({ error: `fixture double has no behaviour for model ${String(input.modelId)}` });
    const inputTokens = tokens(system) + tokens(user);
    const outputTokens = tokens(text);
    return {
      $metadata: {},
      output: { message: { role: "assistant", content: [{ text }] } },
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      stopReason: "end_turn",
      metrics: { latencyMs: 0 },
    } as ConverseCommandOutput;
  };
}

// ---------------------------------------------------------------------------------------------
// Reflector double

interface AnomalyPayload {
  anomalyId: string;
  operation: string;
  param: string;
  docText?: string;
  expectRule?: { kind?: string; max?: number; field?: string };
  expected?: string;
  observed?: string;
}

type Pair = [DefectClass, ProbeTemplate];

const LIST_OPS = new Set(["dodo.listRefunds", "dodo.listPayments", "dodo.listCustomers"]);

/** Rival pool per claim shape: the first entries are the first proposal, the rest re-proposals. */
export function rivalPool(p: Pick<AnomalyPayload, "operation" | "param" | "expectRule">): Pair[] {
  const kind = p.expectRule?.kind ?? "";
  switch (kind) {
    case "maxItems":
      if (LIST_OPS.has(p.operation)) {
        return [
          ["silent_truncation", "boundary_sweep"],
          ["honored", "pagination_completeness"],
          ["silent_truncation", "pagination_completeness"],
          ["honored", "boundary_sweep"],
        ];
      }
      return [
        ["idempotency_hazard", "retry_after_timeout"],
        ["honored", "retry_after_timeout"],
      ];
    case "unit":
      return [
        ["unit_mismatch", "unit_roundtrip"],
        ["silent_coercion", "unit_roundtrip"],
        ["honored", "unit_roundtrip"],
      ];
    case "type":
      return [
        ["silent_coercion", "type_edge"],
        ["mislabelled_semantics", "type_edge"],
        ["honored", "type_edge"],
      ];
    case "idempotentOnRetry":
      return [
        ["idempotency_hazard", "retry_after_timeout"],
        ["honored", "retry_after_timeout"],
      ];
    case "consistentWithin":
      return [
        ["eventual_consistency", "write_then_read"],
        ["honored", "write_then_read"],
      ];
    default:
      return [
        ["silent_coercion", "unknown_param"],
        ["undocumented_flag", "unknown_param"],
        ["honored", "unknown_param"],
      ];
  }
}

const CLASS_TEXT: Record<DefectClass, string> = {
  silent_truncation: "The API silently truncates or clamps instead of enforcing the documented limit",
  silent_coercion: "The API silently converts the value (type, rounding or format) instead of honoring the documented type",
  unit_mismatch: "The amount is handled in a different currency unit than documented (major vs minor units)",
  undocumented_flag: "The behaviour depends on a parameter the docs do not describe",
  eventual_consistency: "The write lands but is not visible to an immediate read",
  idempotency_hazard: "Repeating the request creates a duplicate effect",
  rate_limit: "The response is shaped by throttling",
  expiry: "A resource changed state between calls",
  mislabelled_semantics: "The field means something other than its documented meaning",
  honored: "The documented claim holds; the anomaly is an artefact of the recon request or test data",
};

function shorten(s: string | undefined, max = 160): string {
  const t = (s ?? "").replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function hypothesis(p: AnomalyPayload, [cls, test]: Pair): Record<string, string> {
  const subject = `${p.operation}${p.param ? ` [${p.param}]` : ""}`;
  return {
    class: cls,
    statement: `${CLASS_TEXT[cls]} (${subject}; observed ${shorten(p.observed)}; expected ${shorten(p.expected, 100)}).`,
    distinguishingTest: test,
  };
}

/** First 2–3 pairs from the pool, skipping refuted ones, spanning at least 2 classes. */
function pickRivals(pool: Pair[], refuted: ReadonlySet<string>, max: number): Pair[] {
  const out: Pair[] = [];
  for (const pair of pool) {
    if (refuted.has(pair.join("|"))) continue;
    out.push(pair);
    if (out.length === max) break;
  }
  return new Set(out.map(([c]) => c)).size >= 2 ? out : [];
}

function sliceBetween(text: string, start: string, end?: string): string | undefined {
  const i = text.indexOf(start);
  if (i < 0) return undefined;
  const from = i + start.length;
  const j = end === undefined ? -1 : text.indexOf(end, from);
  return text.slice(from, j < 0 ? undefined : j).trim();
}

export function reflectorReply(user: string): string {
  if (user.startsWith("Every rival hypothesis below was REFUTED")) {
    const anomalyText = sliceBetween(user, "Anomaly:", "Refuted hypotheses:");
    const refutedText = sliceBetween(user, "Refuted hypotheses:", "Refutation evidence");
    if (!anomalyText || !refutedText) return JSON.stringify({ anomalies: [] });
    const p = JSON.parse(anomalyText) as AnomalyPayload;
    const refuted = new Set((JSON.parse(refutedText) as Array<{ class: string; distinguishingTest: string }>).map((h) => `${h.class}|${h.distinguishingTest}`));
    const rivals = pickRivals(rivalPool(p), refuted, 3);
    return JSON.stringify({ anomalies: rivals.length ? [{ anomalyId: p.anomalyId, hypotheses: rivals.map((r) => hypothesis(p, r)) }] : [] });
  }
  const nl = user.indexOf("\n");
  const payloads = JSON.parse(nl >= 0 ? user.slice(nl + 1) : "[]") as AnomalyPayload[];
  return JSON.stringify({
    anomalies: payloads.map((p) => {
      const pool = rivalPool(p);
      const first = pool.length > 3 ? pool.slice(0, 2) : pool;
      return { anomalyId: p.anomalyId, hypotheses: first.map((r) => hypothesis(p, r)) };
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// Adversary double

interface PacketProbeLike {
  id: string;
  cited: boolean;
  template: string;
  params: unknown;
  control: { params: unknown } | null;
  observed: unknown;
}

interface PacketLike {
  belief: { id: string; class: string | null; alpha: number; beta: number; confidence: number };
  claim: { id: string; operation: string; param: string; expect: { kind?: string; max?: number } };
  probes: PacketProbeLike[];
}

const MONEY_WRITES = new Set(["dodo.createRefund", "dodo.createWalletLedgerEntry", "dodo.changeSubscriptionPlan"]);

export interface AdversaryDecision {
  verdict: "uphold" | "narrow" | "downgrade";
  reason: string;
  scope?: string;
  untestedAlternative?: string;
}

export function adversaryDecision(packet: PacketLike): AdversaryDecision {
  const { belief, claim } = packet;
  const cited = packet.probes.filter((p) => p.cited);
  const ids = cited.map((p) => p.id).join(", ");
  if (cited.length < 2) {
    return { verdict: "downgrade", reason: `Only ${cited.length} cited probe(s); one experiment cannot carry a belief.` };
  }
  // Rule 2: does each cited probe vary the claim's parameter?
  if (claim.param !== "") {
    for (const p of cited) {
      // Only value templates vary the parameter itself (params.ts): count templates vary how often the
      // op is sent, record templates (type_edge) send the same parameter to different records.
      if (COUNT_TEMPLATES.has(p.template as ProbeTemplate) || EXERCISE_TEMPLATES.has(p.template as ProbeTemplate)) continue;
      const tv = requestSteps(p.params).flatMap((s) => valuesAtPath(s.params, claim.param));
      const cv = requestSteps(p.control?.params).flatMap((s) => valuesAtPath(s.params, claim.param));
      if (tv.length > 0 && canonicalJson(tv) === canonicalJson(cv)) {
        return { verdict: "downgrade", reason: `Probe ${p.id} sent the same ${claim.param} (${canonicalJson(tv)}) in treatment and control, so it did not test the parameter.` };
      }
    }
  }
  // Rule 3: clamping to the documented max is not evidence of lost data.
  const max = claim.expect.max;
  if (
    belief.class === "silent_truncation" &&
    claim.expect.kind === "maxItems" &&
    typeof max === "number" &&
    cited.every((p) => p.template === "boundary_sweep" && (p.observed as { over?: { length?: unknown } } | null)?.over?.length === max)
  ) {
    return {
      verdict: "downgrade",
      reason: `Every cited probe (${ids}) is a boundary_sweep that saw the over-limit request clamped to exactly ${max} items. Clamping enforces "max is ${max}"; no cited probe checked whether any items were lost.`,
      untestedAlternative: `The limit is enforced by clamping rather than rejecting, and listings stay complete (the documented max holds); a pagination_completeness probe would tell them apart.`,
    };
  }
  // Rule 4: scope — a money write probed in a single currency.
  const violated = belief.class !== null && belief.class !== "honored";
  if (violated && MONEY_WRITES.has(claim.operation)) {
    const currencies = new Set(
      cited.flatMap((p) => requestSteps(p.params).filter((s) => s.op === claim.operation).flatMap((s) => valuesAtPath(s.params, "currency"))).map((v) => String(v)),
    );
    if (currencies.size === 1) {
      const cur = [...currencies][0]!;
      return {
        verdict: "narrow",
        reason: `The cited probes (${ids}) vary ${claim.param || "the request"} and each control read differently, but every one of them used currency ${cur}.`,
        scope: `${cur} only: ${claim.operation} was probed with ${cur} amounts; other currencies are untested`,
      };
    }
  }
  return {
    verdict: "uphold",
    reason: `${cited.length} cited probes (${ids}) vary the parameter, their controls read differently, and they agree (Beta(${belief.alpha}, ${belief.beta})).`,
  };
}

export function adversaryReply(user: string): string {
  const json = sliceBetween(user, "<packet>", "</packet>");
  if (!json) return JSON.stringify({ verdict: "downgrade", reason: "No evidence packet in the request." });
  return JSON.stringify(adversaryDecision(JSON.parse(json) as PacketLike));
}
