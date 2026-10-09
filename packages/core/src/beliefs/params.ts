/**
 * Shared, deterministic reads of a probe's treatment/control requests at a claim's parameter.
 * Used by the evidence-validity check (FR-10) and by the independence rule of the belief store.
 *
 * A probe's `params` / `control.params` are template VariantParams: `{ steps: ProbeStep[], ... }`
 * where each step is `{ op, params, repeat?, setup?, delayMs? }`. Setup steps only feed `$from`
 * refs and are ignored here.
 *
 * Paths: `claim.param` is a dotted path into a step's params; a segment ending in `[]` iterates an
 * array (e.g. "items[].amount", "price.price"). Missing segments yield no value.
 */
import { canonicalJson } from "../bundle/hash.js";
import type { Claim, Probe, ProbeTemplate } from "../schema/index.js";

export interface RequestStep {
  op: string;
  params: Record<string, unknown>;
  repeat?: number;
  setup?: boolean;
}

/** Templates whose variable is HOW OFTEN the claim's operation is sent (count/repeat). */
export const COUNT_TEMPLATES: ReadonlySet<ProbeTemplate> = new Set<ProbeTemplate>([
  "retry_after_timeout", // the same write sent N times
  "header_burst", // the request rate
  "write_then_read", // the write happens in the treatment only
]);

/**
 * Templates that vary the INPUT record while both variants request the claim's parameter
 * (type_edge: the same `fields` request on two different records). The parameter counts as
 * exercised when the treatment carries it and the two variants' requests differ.
 */
export const EXERCISE_TEMPLATES: ReadonlySet<ProbeTemplate> = new Set<ProbeTemplate>(["type_edge"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Non-setup request steps of a VariantParams-like value. */
export function requestSteps(variant: unknown): RequestStep[] {
  if (!isRecord(variant) || !Array.isArray(variant.steps)) return [];
  const out: RequestStep[] = [];
  for (const s of variant.steps) {
    if (!isRecord(s) || typeof s.op !== "string") continue;
    if (s.setup === true) continue;
    out.push({
      op: s.op,
      params: isRecord(s.params) ? s.params : {},
      ...(typeof s.repeat === "number" ? { repeat: s.repeat } : {}),
    });
  }
  return out;
}

/** Values found at a dotted path ("a.b", "items[].amount"). */
export function valuesAtPath(obj: unknown, path: string): unknown[] {
  if (path === "") return [];
  let cur: unknown[] = [obj];
  for (const raw of path.split(".")) {
    const iter = raw.endsWith("[]");
    const key = iter ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const v of cur) {
      const at = key === "" ? v : isRecord(v) ? v[key] : undefined;
      if (at === undefined) continue;
      if (iter) {
        if (Array.isArray(at)) next.push(...at);
      } else next.push(at);
    }
    cur = next;
  }
  return cur;
}

function sortedCanon(values: readonly unknown[]): string {
  return canonicalJson(values.map((v) => canonicalJson(v ?? null)).sort());
}

function sendCount(steps: readonly RequestStep[]): number {
  return steps.reduce((n, s) => n + Math.max(1, s.repeat ?? 1), 0);
}

/** Steps on the claim's operation when the treatment has any, else all steps (same rule both sides). */
function focus(claim: Claim, t: RequestStep[], c: RequestStep[]): { t: RequestStep[]; c: RequestStep[]; onOp: boolean } {
  const tOp = t.filter((s) => s.op === claim.operation);
  if (tOp.length === 0) return { t, c, onOp: false };
  return { t: tOp, c: c.filter((s) => s.op === claim.operation), onOp: true };
}

export interface Variation {
  varied: boolean;
  how: string;
}

/**
 * Did this probe vary (or, for count/exercise templates, exercise) the claim's parameter?
 *
 *  1. value rule: the multiset of values at `claim.param` across the treatment's requests differs
 *     from the control's (present vs absent counts as a difference — unknown_param);
 *  2. count rule (COUNT_TEMPLATES): the treatment sends the claim's operation (or, when the
 *     treatment never calls it, its target op) more times than the control;
 *  3. exercise rule (EXERCISE_TEMPLATES): the treatment carries `claim.param` and the variants'
 *     requests differ;
 *  4. claims with no single param (`param: ""`): the variants' requests differ.
 * Anything else: not varied.
 */
export function paramVariation(claim: Claim, probe: Pick<Probe, "template" | "params" | "control">): Variation {
  if (!probe.control) return { varied: false, how: "probe has no control variant" };
  const all = { t: requestSteps(probe.params), c: requestSteps(probe.control.params) };
  if (all.t.length === 0) return { varied: false, how: "treatment sent no request" };
  const { t, c, onOp } = focus(claim, all.t, all.c);
  const where = onOp ? claim.operation : "the probe's target op";
  const requestsDiffer = canonicalJson(t.map((s) => ({ op: s.op, params: s.params, repeat: s.repeat ?? 1 }))) !==
    canonicalJson(c.map((s) => ({ op: s.op, params: s.params, repeat: s.repeat ?? 1 })));

  if (claim.param !== "") {
    const tv = t.flatMap((s) => valuesAtPath(s.params, claim.param));
    const cv = c.flatMap((s) => valuesAtPath(s.params, claim.param));
    if (sortedCanon(tv) !== sortedCanon(cv)) {
      return { varied: true, how: `${claim.param} differs on ${where}: treatment ${canonicalJson(tv)} vs control ${canonicalJson(cv)}` };
    }
    if (EXERCISE_TEMPLATES.has(probe.template) && tv.length > 0 && requestsDiffer) {
      return { varied: true, how: `${claim.param} exercised on ${where} (sent in the treatment; the variants' records differ)` };
    }
  }
  if (COUNT_TEMPLATES.has(probe.template)) {
    const tc = sendCount(t);
    const cc = sendCount(c);
    if (tc > cc) return { varied: true, how: `exercised by count: treatment sends ${where} ${tc}x vs control ${cc}x` };
  }
  if (claim.param === "" && requestsDiffer) {
    return { varied: true, how: `claim names no single param; treatment and control requests differ on ${where}` };
  }
  return {
    varied: false,
    how: claim.param === "" ? `treatment and control send identical requests on ${where}` : `${claim.param} is identical in treatment and control on ${where}`,
  };
}

/**
 * Independence fingerprint of a probe for a claim: template + the treatment's values at
 * `claim.param` (template alone when the claim has no param or the treatment carries none), plus
 * `#v<k>` when the template built design variant k > 0 (templates stamp `variant` only when the
 * variant really changes the treatment: a different value at the param or a different record).
 * Two probes are independent iff their ids AND fingerprints differ.
 */
export function designFingerprint(claim: Claim, probe: Pick<Probe, "template" | "params">): string {
  const v = isRecord(probe.params) && typeof probe.params.variant === "number" && probe.params.variant > 0 ? `#v${probe.params.variant}` : "";
  if (claim.param === "") return `${probe.template}${v}`;
  const steps = requestSteps(probe.params);
  const onOp = steps.filter((s) => s.op === claim.operation);
  const values = (onOp.length ? onOp : steps).flatMap((s) => valuesAtPath(s.params, claim.param));
  return values.length ? `${probe.template}|${claim.param}=${sortedCanon(values)}${v}` : `${probe.template}${v}`;
}
