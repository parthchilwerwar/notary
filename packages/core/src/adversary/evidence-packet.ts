/**
 * The adversary's evidence packet (TDD "The notarization loop", step 8): the belief under review,
 * its claim, and the RAW probe records — never the reflector's prose.
 *
 * Per probe the packet carries: template, params, control params (+ control observation), the
 * committed predictions (hypothesis id -> {class, outcomes}, i.e. the defect class and the
 * code-derived predicted observation, but no hypothesis statement), observed, verdict, credits,
 * calls, and the trace/span ids the belief cites. Everything is serialized with canonicalJson, so
 * the same inputs always give byte-identical packets.
 *
 * Two code-level guards (not prompt-level):
 *   - predictions are WHITELISTED to {class, outcomes}; anything else a prediction value carries
 *     is dropped, and
 *   - `assertNoReflectorProse` walks the hypothesis-derived part of the packet and throws if a
 *     field named statement / explanation / rationale survived.
 *
 * Secrets: probe bodies come from redacted cassettes; as a backstop, the value of every
 * secret-looking env var (…KEY, …TOKEN, …SECRET, …PASSWORD, …CREDENTIAL) is scrubbed from the
 * packet before it is serialized.
 */
import { canonicalJson } from "../bundle/hash.js";
import type { Belief, Claim, Probe } from "../schema/index.js";

type Env = Record<string, string | undefined>;

export const PACKET_KIND = "notary.adversary.packet";
export const PACKET_VERSION = 1;

/** Field names that carry reflector prose. They may never appear in the hypothesis-derived data. */
export const FORBIDDEN_PROSE_FIELDS: readonly string[] = ["statement", "explanation", "rationale"];

/** Values longer than this (as canonical JSON) are replaced by a truncated string. */
export const MAX_VALUE_CHARS = 6000;

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
const REDACTED = "[REDACTED]";

export type PacketPrediction = {
  hypothesisId: string;
  /** Defect class of the hypothesis this prediction belongs to (null if the record lacks it). */
  class: string | null;
  /** Predicted outcomes, derived by code from the class ("*" = no prediction under this template). */
  predicted: unknown;
};

export type PacketProbe = {
  id: string;
  /** True when the belief cites this probe in its evidence. */
  cited: boolean;
  template: string;
  params: unknown;
  control: { params: unknown; observed: unknown } | null;
  predictions: PacketPrediction[];
  predictionHash: string;
  committedAt: string;
  ranAt: string | null;
  observed: unknown;
  verdict: string | null;
  winningHypothesisId: string | null;
  costCredits: number;
  calls: number;
  traceId: string;
  spanId: string | null;
};

export type EvidencePacket = {
  kind: typeof PACKET_KIND;
  version: typeof PACKET_VERSION;
  belief: {
    id: string;
    claimId: string;
    tool: string;
    class: string | null;
    statement: string;
    status: string;
    alpha: number;
    beta: number;
    confidence: number;
    evidence: { probeId: string; traceId: string; spanId: string | null }[];
  };
  claim: {
    id: string;
    tool: string;
    operation: string;
    endpoint: string | null;
    param: string;
    docText: string;
    docUrl: string;
    expect: unknown;
  };
  probes: PacketProbe[];
};

export type BuiltPacket = { packet: EvidencePacket; json: string };

function secretEnvValues(env: Env): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(name) && value && value.trim().length >= 8) out.push(value.trim());
  }
  // Longest first, so a secret that contains another is scrubbed whole.
  return out.sort((a, b) => b.length - a.length);
}

/** Deep copy of `value` with every occurrence of a secret replaced. Pure (does not mutate). */
export function scrubSecrets(value: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") {
    let s = value;
    for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join(REDACTED);
    return s;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, secrets));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubSecrets(v, secrets);
  return out;
}

/** JSON-safe, size-capped copy of a raw record value (undefined -> null). Deterministic. */
function raw(value: unknown): unknown {
  if (value === undefined) return null;
  let text: string;
  try {
    text = canonicalJson(value);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
  if (text.length <= MAX_VALUE_CHARS) return JSON.parse(text) as unknown;
  return `${text.slice(0, MAX_VALUE_CHARS)}…[truncated ${text.length - MAX_VALUE_CHARS} chars]`;
}

/** Whitelist a committed prediction down to the defect class and the predicted outcomes. */
function predictionEntry(hypothesisId: string, value: unknown): PacketPrediction {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const cls = typeof rec.class === "string" ? rec.class : null;
    const predicted = "outcomes" in rec ? raw(rec.outcomes) : raw(stripProse(rec));
    return { hypothesisId, class: cls, predicted };
  }
  return { hypothesisId, class: null, predicted: raw(value) };
}

/** Deep copy without any FORBIDDEN_PROSE_FIELDS keys. */
function stripProse(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripProse);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PROSE_FIELDS.includes(k.toLowerCase())) continue;
    out[k] = stripProse(v);
  }
  return out;
}

/** Path of the first forbidden prose field inside `value`, or null. */
function findProse(value: unknown, path: string): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findProse(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PROSE_FIELDS.includes(k.toLowerCase())) return `${path}.${k}`;
    const hit = findProse(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Throws if any hypothesis-derived part of the packet (the predictions) carries a field named
 * statement / explanation / rationale, or if the packet has any top-level section other than the
 * belief, claim and probes. `belief.statement` is the claim under review, not reflector prose.
 */
export function assertNoReflectorProse(packet: EvidencePacket): void {
  const allowed = new Set(["kind", "version", "belief", "claim", "probes"]);
  for (const k of Object.keys(packet)) {
    if (!allowed.has(k)) throw new Error(`adversary packet: unexpected section "${k}"`);
  }
  for (const [i, p] of packet.probes.entries()) {
    const hit = findProse(p.predictions, `probes[${i}].predictions`);
    if (hit) throw new Error(`adversary packet: reflector prose field at ${hit}`);
    for (const k of Object.keys(p)) {
      if (FORBIDDEN_PROSE_FIELDS.includes(k.toLowerCase())) {
        throw new Error(`adversary packet: reflector prose field at probes[${i}].${k}`);
      }
    }
  }
}

function packetProbe(p: Probe, cited: boolean): PacketProbe {
  const predictions = Object.keys(p.prediction)
    .sort()
    .map((hid) => predictionEntry(hid, p.prediction[hid]));
  return {
    id: p.id,
    cited,
    template: p.template,
    params: raw(p.params),
    control: p.control ? { params: raw(p.control.params), observed: raw(p.control.observed) } : null,
    predictions,
    predictionHash: p.predictionHash,
    committedAt: p.committedAt,
    ranAt: p.ranAt ?? null,
    observed: raw(p.observed),
    verdict: p.verdict ?? null,
    winningHypothesisId: p.winningHypothesisId ?? null,
    costCredits: p.costCredits,
    calls: p.calls,
    traceId: p.traceId,
    spanId: p.spanId ?? null,
  };
}

/**
 * Build the adversary's input. Only probes for the belief's claim are included, ordered by
 * commit time then id. Returns the packet object and its canonical JSON.
 */
export function buildEvidencePacket(args: {
  belief: Belief;
  claim: Claim;
  probes: readonly Probe[];
  env?: Env;
}): BuiltPacket {
  const { belief, claim } = args;
  if (belief.claimId !== claim.id) {
    throw new Error(`adversary packet: belief ${belief.id} is for claim ${belief.claimId}, not ${claim.id}`);
  }
  const cited = new Set(belief.evidence.map((e) => e.probeId));
  const probes = args.probes
    .filter((p) => p.claimId === claim.id)
    .slice()
    .sort((a, b) => (a.committedAt === b.committedAt ? cmp(a.id, b.id) : cmp(a.committedAt, b.committedAt)))
    .map((p) => packetProbe(p, cited.has(p.id)));

  const unscrubbed: EvidencePacket = {
    kind: PACKET_KIND,
    version: PACKET_VERSION,
    belief: {
      id: belief.id,
      claimId: belief.claimId,
      tool: belief.tool,
      class: belief.class ?? null,
      statement: belief.statement,
      status: belief.status,
      alpha: belief.alpha,
      beta: belief.beta,
      confidence: belief.confidence,
      evidence: belief.evidence.map((e) => ({ probeId: e.probeId, traceId: e.traceId, spanId: e.spanId ?? null })),
    },
    claim: {
      id: claim.id,
      tool: claim.tool,
      operation: claim.operation,
      endpoint: claim.endpoint ?? null,
      param: claim.param,
      docText: claim.docText,
      docUrl: claim.docUrl,
      expect: raw(claim.expect),
    },
    probes,
  };
  const packet = scrubSecrets(unscrubbed, secretEnvValues(args.env ?? process.env)) as EvidencePacket;
  assertNoReflectorProse(packet);
  return { packet, json: canonicalJson(packet) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
