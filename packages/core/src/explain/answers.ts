// Deterministic explain answers, built from records only (no model). Each answer is plain text
// plus the ids of the records every sentence was read from; numbers are computed from those
// records. When a record is missing the answer says so; it never fills the gap.
//
//   whyHeld        why a queue item was held: the gate's required vs missing beliefs and their
//                  status, the guard or missing certificate that decided it, the evidence pack's
//                  probes and verdicts, the adversary review
//   toolKnowledge  what is known about a tool: certified / contradicted / unproven / revoked claims,
//                  notarized beliefs with confidence, probes and guards
//   runDiff        what changed between two runs of one world: decision and belief statuses,
//                  metric deltas (null-safe), guards added or retired
//   revocations    every revoked certificate, its trigger probes and traces and the guards retired
//
// Browser-safe (no Node imports).
import type { Certificate, Revocation, ToolCertificates } from "../schema/certificate.js";
import type { Citation, ExplainAnswer } from "../schema/explain.js";
import type { Belief, Decision, Guard, Probe, RunBundle, Tool } from "../schema/index.js";
import { AnswerWriter, cite, claimOfBelief, list, num, p4, plural, quote, signed, tally } from "./text.js";
import type { World } from "./world.js";
import { findProbe, makeWorld, toolCertificates, worldKeyOf, worldLabel } from "./world.js";

// --- shared helpers ------------------------------------------------------------------------------

function prefix(world: World): string | undefined {
  return world.sample ? `${worldLabel(world)}:` : undefined;
}

function shortWorld(world: World): string {
  return world.key === "real" ? "the real runs" : world.key.startsWith("fixture:") ? `fixture scenario ${world.key.slice(8)}` : world.key;
}

function bundleIn(world: World, runId: string): RunBundle | undefined {
  return world.bundles.find((b) => b.runId === runId);
}

/** A belief citation, only if that run actually holds a snapshot of the belief. */
function beliefCite(world: World, runId: string, beliefId: string): Citation[] {
  const b = bundleIn(world, runId);
  return b && [...b.beliefs.before, ...b.beliefs.after].some((x) => x.id === beliefId) ? [cite.belief(runId, beliefId)] : [];
}

/** The winning hypothesis' class recorded in a confirmed probe's prediction, if any. */
function winningClass(p: Probe): string | undefined {
  if (!p.winningHypothesisId) return undefined;
  const pred = p.prediction[p.winningHypothesisId];
  if (pred && typeof pred === "object" && "class" in pred && typeof (pred as { class: unknown }).class === "string") return (pred as { class: string }).class;
  return undefined;
}

function probeWords(p: Probe): string {
  const cls = winningClass(p);
  return `${p.template} ${p.verdict ?? "not run"}${cls ? ` ${cls}` : ""}`;
}

/** "P(doc claim holds) = 0.0625, Beta(1, 4)". */
function confidenceWords(x: Pick<Belief, "alpha" | "beta" | "confidence">): string {
  return `P(doc claim holds) = ${p4(x.confidence)}, Beta(${num(x.alpha)}, ${num(x.beta)})`;
}

function sideWords(confidence: number): string {
  return confidence >= 0.5 ? "the docs hold" : "the docs are contradicted";
}

function resolveProbes(world: World, ids: readonly string[]): { found: Array<{ probe: Probe; runId: string }>; missing: string[] } {
  const found: Array<{ probe: Probe; runId: string }> = [];
  const missing: string[] = [];
  for (const id of ids) {
    const hit = findProbe(world, id);
    if (hit) found.push(hit);
    else missing.push(id);
  }
  return { found, missing };
}

function certificateFor(world: World, tool: Tool, claimId: string): { tc?: ToolCertificates; certs: Certificate[]; revocations: Revocation[] } {
  const tc = toolCertificates(world, tool);
  return {
    tc,
    certs: tc ? tc.certificates.filter((c) => c.claimId === claimId) : [],
    revocations: tc ? tc.revocations.filter((r) => r.claimId === claimId) : [],
  };
}

function asWorld(input: readonly RunBundle[] | World, certificates?: readonly ToolCertificates[]): World {
  return Array.isArray(input) ? makeWorld(input as RunBundle[], certificates ?? []) : (input as World);
}

// --- why was this item held? ----------------------------------------------------------------------

export function whyHeldId(runId: string, decisionId: string): string {
  return `why_held:${runId}:${decisionId}`;
}

/**
 * Why a held decision was held. `world` supplies the other runs of the same world (the notarize
 * runs whose probes the evidence pack cites) and its certificates; default: this bundle alone.
 */
export function whyHeld(bundle: RunBundle, decisionId: string, world: World = makeWorld([bundle])): ExplainAnswer {
  const own = bundleIn(world, bundle.runId);
  if (!own || own.contentHash !== bundle.contentHash) throw new Error(`explain: ${bundle.runId} is not a bundle of world ${world.key}`);
  const d = bundle.decisions.find((x) => x.id === decisionId);
  if (!d) throw new Error(`explain: no decision ${decisionId} in ${bundle.runId}`);
  if (d.status !== "held") throw new Error(`explain: decision ${decisionId} in ${bundle.runId} was ${d.status}, not held`);

  const w = new AnswerWriter(prefix(world));
  w.run(bundle.runId);
  const dc = cite.decision(bundle.runId, d);
  w.say(
    `In run ${bundle.runId}, queue item ${d.requestId} (${d.requestType}, customer ${d.customerId}, tier ${d.tier}) had policy outcome ${d.policyOutcome}; its action ${d.action} was held, not executed`,
    [dc],
  );

  // Required vs missing beliefs, with their status in this run's snapshots.
  const snapshot = (id: string): { before?: Belief; after?: Belief } => ({
    before: bundle.beliefs.before.find((x) => x.id === id),
    after: bundle.beliefs.after.find((x) => x.id === id),
  });
  const missing = new Set(d.missingBeliefs);
  if (!d.requiredBeliefs.length) {
    w.say("The decision lists no required beliefs for this action", [dc]);
  } else {
    w.say(
      `The certificate gate requires ${plural(d.requiredBeliefs.length, "notarized belief")} for this action; ${
        missing.size ? `${missing.size} ${missing.size === 1 ? "was" : "were"} missing` : "none was recorded as missing"
      }`,
      [dc],
    );
    const present = d.requiredBeliefs.filter((id) => !missing.has(id));
    const presentCited = present.flatMap((id) => beliefCite(world, bundle.runId, id));
    if (present.length) {
      // Status at the start of the run (what the gate saw unless an event in the run changed it),
      // plus the end-of-run status when it differs.
      const words = present.map((id) => {
        const { before, after } = snapshot(id);
        const s = before ?? after;
        if (!s) return `${claimOfBelief(id)} (no snapshot in this run)`;
        const end = before && after && after.status !== before.status ? `; ${after.status} by the end of the run` : "";
        return `${claimOfBelief(id)} (${before ? "at the start of the run" : "at the end of the run"}: ${s.status}${s.status === "notarized" ? `, ${sideWords(s.confidence)}` : ""}${end})`;
      });
      if (presentCited.length) w.say(`Not missing: ${list(words)}`, presentCited);
      else w.absent(`This run holds no snapshot of the ${plural(present.length, "required belief")} that were not missing`);
    }
  }

  // The deciding factor: missing beliefs first, then a guard named in the recorded reason.
  const reason = d.evidencePack?.reason ?? d.error ?? "";
  const namedGuards = [...new Set(reason.match(/grd-[0-9a-f]+/g) ?? [])];
  const guards = namedGuards.map((id) => bundle.guards.find((g) => g.id === id)).filter((g): g is Guard => g !== undefined);
  if (missing.size) {
    for (const id of d.missingBeliefs) explainMissingBelief(w, world, bundle, id, dc);
  }
  for (const g of guards) {
    const gc = cite.guard(bundle.runId, g);
    const state = g.active ? "still active at the end of the run" : `at the end of the run: retired at ${g.retiredAt ?? "an unrecorded time"}`;
    const applied = d.guardsApplied.includes(g.id);
    w.say(
      `${missing.size ? "The recorded reason also names" : "It was held because the recorded reason names"} guard ${g.id} (${g.kind} on ${g.operation}, compiled from ${g.beliefId}${
        g.class ? `, class ${g.class}` : ""
      }; ${state})${applied ? ", which this decision applied" : ""}`,
      [dc, gc, ...beliefCite(world, bundle.runId, g.beliefId)],
    );
    w.say(`The guard's compiled reason: ${quote(g.reason)}`, [gc]);
  }
  for (const id of namedGuards.filter((x) => !guards.some((g) => g.id === x))) w.absent(`The recorded reason names guard ${id}, which this run's bundle does not hold`);
  if (!missing.size && !guards.length) w.say("The decision records neither a missing belief nor a guard that refused it; its recorded reason below is all there is", [dc]);
  if (reason) w.say(`Recorded reason: ${quote(reason)}`, [dc]);
  else w.absent("The decision carries no recorded reason");

  // The evidence pack.
  const pack = d.evidencePack;
  if (!pack) {
    w.absent("No evidence pack is attached to this decision");
  } else if (!pack.relatedProbeIds.length) {
    w.say("Its evidence pack cites no probes", [dc]);
  } else {
    const { found, missing: lost } = resolveProbes(world, pack.relatedProbeIds);
    const byClaim = new Map<string, Array<{ probe: Probe; runId: string }>>();
    for (const f of found) byClaim.set(f.probe.claimId, [...(byClaim.get(f.probe.claimId) ?? []), f]);
    if (found.length) {
      const runs = [...new Set(found.map((f) => f.runId))];
      w.say(
        `Its evidence pack cites ${plural(pack.relatedProbeIds.length, "probe")} (from ${list(runs)}): ${[...byClaim]
          .map(([claim, ps]) => `${claim}: ${tally(ps.map((x) => probeWords(x.probe)))}`)
          .join("; ")}`,
        [dc, ...found.map((f) => cite.probe(f.runId, f.probe))],
      );
    }
    if (lost.length) w.absent(`${plural(lost.length, "cited probe id")} ${lost.length === 1 ? "is" : "are"} not in any published run of this world: ${list(lost)}`);
  }

  // The grade, when there is ground truth.
  if (d.grade) {
    const g = d.grade;
    w.say(
      `Graded against the hand-written expected outcome (${g.expectedOutcome}${g.expectedStatus ? `, expected status ${g.expectedStatus}` : ""}): ${g.correct ? "correct" : "not correct"}, ${
        g.unsafe.length ? `unsafe: ${list(g.unsafe)}` : "no unsafe action"
      }`,
      [dc],
    );
  } else {
    w.absent("This decision has no grade (no expected outcome for it)");
  }

  return w.build({
    id: whyHeldId(bundle.runId, d.id),
    kind: "why_held",
    question: `Why was ${d.requestId} held in run ${bundle.runId}?`,
    sample: world.sample,
  });
}

function explainMissingBelief(w: AnswerWriter, world: World, bundle: RunBundle, beliefId: string, dc: Citation): void {
  const before = bundle.beliefs.before.find((x) => x.id === beliefId);
  const after = bundle.beliefs.after.find((x) => x.id === beliefId);
  const snap = after ?? before;
  const bc = beliefCite(world, bundle.runId, beliefId);
  if (!snap || !bc.length) {
    w.say(`It was held because required belief ${beliefId} was not notarized`, [dc]);
    w.absent(`This run holds no snapshot of ${beliefId}`);
    return;
  }
  const changed = before && after && before.status !== after.status ? ` (it was ${before.status} at the start of the run)` : "";
  w.say(
    `It was held because required belief ${claimOfBelief(beliefId)} was not notarized: at the end of the run it was ${snap.status}, ${confidenceWords(snap)}${changed}`,
    [dc, ...bc],
  );
  w.say(`That belief states: ${quote(snap.statement)}`, bc);

  // Status changes of this belief during the run (e.g. a re-verification sentinel un-learning it).
  const events = bundle.beliefEvents.map((e, i) => ({ e, i })).filter((x) => x.e.beliefId === beliefId);
  const moves = events.filter((x) => x.e.from !== x.e.to);
  if (events.length) {
    const probeCites = events.flatMap((x) => {
      const hit = x.e.probeId ? findProbe(world, x.e.probeId) : undefined;
      return hit ? [cite.probe(hit.runId, hit.probe)] : [];
    });
    w.say(
      `During this run it has ${plural(events.length, "belief event")}${
        moves.length
          ? `; status changes: ${moves.map((x) => `${x.e.from ?? "new"} → ${x.e.to} at ${x.e.at}${x.e.probeId ? ` on probe ${x.e.probeId}` : ""}`).join("; ")}`
          : "; none changed its status"
      }`,
      [...events.map((x) => cite.beliefEvent(bundle.runId, beliefId, x.i)), ...probeCites],
    );
    for (const m of moves) w.say(`Recorded reason for ${m.e.from ?? "new"} → ${m.e.to}: ${quote(m.e.reason)}`, [cite.beliefEvent(bundle.runId, beliefId, m.i)]);
  }

  if (snap.adversary) {
    const a = snap.adversary;
    w.say(`Adversary review: ${a.verdict}${a.backend ? ` (${a.backend}, ${a.model})` : ` (${a.model})`}: ${quote(a.reason)}`, bc);
  } else {
    w.absent("No adversary review is recorded on this belief");
  }
  const cited = resolveProbes(world, snap.evidence.map((e) => e.probeId));
  if (cited.found.length) {
    w.say(
      `The belief cites ${plural(snap.evidence.length, "probe")}: ${tally(cited.found.map((f) => probeWords(f.probe)))}`,
      [...bc, ...cited.found.map((f) => cite.probe(f.runId, f.probe))],
    );
  } else if (snap.evidence.length) {
    w.say(`The belief cites ${plural(snap.evidence.length, "probe")}`, bc);
  } else {
    w.say("The belief cites no probes", bc);
  }
  if (cited.missing.length) w.absent(`${cited.missing.length} of its cited probe ids ${cited.missing.length === 1 ? "is" : "are"} not in any published run of this world: ${list(cited.missing)}`);

  // Certificate status for the claim.
  const { tc, certs, revocations } = certificateFor(world, snap.tool, snap.claimId);
  if (!tc) {
    w.absent(`No ${snap.tool} certificates were supplied for this world`);
    return;
  }
  const active = certs.filter((c) => c.status === "active");
  for (const r of revocations) {
    const c = certs.find((x) => x.id === r.certificateId);
    w.say(
      `Its certificate ${r.certificateId} was revoked at ${r.revokedAt} (belief ${r.from} → ${r.to}, ${confidenceWords(r)})`,
      [cite.revocation(r), ...(c ? [cite.certificate(c)] : [])],
    );
  }
  for (const c of active) w.say(`Certificate ${c.id} for ${c.claimId} is active (${c.verdict})`, [cite.certificate(c)]);
  if (!certs.length) {
    const nc = tc.noCertificates.find((x) => x.claimId === snap.claimId);
    if (nc) w.say(`No certificate was issued for ${snap.claimId}: ${quote(nc.reason)}`, bc);
    else w.say(`No certificate was issued for ${snap.claimId}`, bc);
  }
}

// --- what is known about a tool? ------------------------------------------------------------------

export function toolKnowledgeId(worldKey: string, tool: Tool): string {
  return `tool_knowledge:${worldKey}:${tool}`;
}

/**
 * What one world's records say about a tool. `bundles` must all be one world (or pass a World);
 * `certificates` are those derived from the same bundles. null when no run in the world speaks
 * about the tool (nothing to cite).
 */
export function toolKnowledge(tool: Tool, bundles: readonly RunBundle[] | World, certificates?: readonly ToolCertificates[]): ExplainAnswer | null {
  const world = asWorld(bundles, certificates);
  const runs = world.bundles.filter((b) => b.tool === tool || b.probes.some((p) => p.tool === tool) || b.beliefs.after.some((x) => x.tool === tool));
  if (!runs.length) return null;
  const w = new AnswerWriter(prefix(world));
  for (const b of runs) w.run(b.runId);

  // Claims seen in the runs.
  const claimRun = new Map<string, string>();
  for (const b of world.bundles) for (const c of b.claims) if (c.tool === tool && !claimRun.has(c.id)) claimRun.set(c.id, b.runId);
  if (claimRun.size) {
    w.say(`${plural(claimRun.size, `documented ${tool} claim`)} appear in this world's runs`, [...claimRun].map(([id, runId]) => cite.claim(runId, id)));
  } else {
    w.absent(`No run in this world records the ${tool} claims themselves`);
  }

  // Latest snapshot of every belief about the tool.
  const latest = new Map<string, { belief: Belief; runId: string }>();
  for (const b of world.bundles) for (const x of b.beliefs.after) if (x.tool === tool) latest.set(x.id, { belief: x, runId: b.runId });
  const beliefCiteFor = (claimId: string): Citation[] => {
    for (const { belief, runId } of latest.values()) if (belief.claimId === claimId) return [cite.belief(runId, belief.id)];
    const r = claimRun.get(claimId);
    return r ? [cite.claim(r, claimId)] : [];
  };

  // Certificates.
  const tc = toolCertificates(world, tool);
  if (tc) {
    const active = tc.certificates.filter((c) => c.status === "active");
    const matches = active.filter((c) => c.side === "honored");
    const contra = active.filter((c) => c.side === "violated");
    const revoked = tc.certificates.filter((c) => c.status === "revoked");
    if (active.length) {
      w.say(
        `Certified: ${active.length} ${tool} ${active.length === 1 ? "claim" : "claims"} (${matches.length} ${matches.length === 1 ? "matches" : "match"} the docs, ${contra.length} ${contra.length === 1 ? "contradicts" : "contradict"} them)`,
        active.map(cite.certificate),
      );
    } else {
      w.absent(`No ${tool} claim holds an active certificate`);
    }
    for (const c of matches) w.say(`${c.claimId}: matches the docs (certificate ${c.id}, ${confidenceWords(c)})`, [cite.certificate(c)]);
    for (const c of contra) w.say(`${c.claimId}: ${c.verdict} (certificate ${c.id}, ${confidenceWords(c)})`, [cite.certificate(c)]);
    for (const c of revoked) {
      const r = tc.revocations.find((x) => x.certificateId === c.id);
      w.say(
        `${c.claimId}: certificate ${c.id} was revoked${r ? ` at ${r.revokedAt} (belief ${r.from} → ${r.to})` : ""}`,
        [cite.certificate(c), ...(r ? [cite.revocation(r)] : [])],
      );
    }
    if (tc.noCertificates.length) {
      const cites = tc.noCertificates.flatMap((n) => beliefCiteFor(n.claimId));
      const text = `Unproven: ${plural(tc.noCertificates.length, `${tool} claim`)} without an active certificate (${tally(tc.noCertificates.map((n) => n.kind))})`;
      if (cites.length) w.say(text, cites);
      else w.absent(text);
    }
  } else {
    w.absent(`No ${tool} certificates were supplied for this world; what follows comes from belief snapshots only`);
  }

  // Notarized beliefs with confidence and their cited probes.
  const all = [...latest.values()].sort((x, y) => (x.belief.id < y.belief.id ? -1 : x.belief.id > y.belief.id ? 1 : 0));
  const notarized = all.filter((x) => x.belief.status === "notarized");
  for (const { belief, runId } of notarized) {
    const ev = resolveProbes(world, belief.evidence.map((e) => e.probeId));
    w.say(
      `${claimOfBelief(belief.id)} is notarized (latest snapshot in ${runId}): ${confidenceWords(belief)}, so ${sideWords(belief.confidence)}${
        belief.confidence < 0.5 && belief.class ? ` (${belief.class})` : ""
      }; ${plural(belief.evidence.length, "cited probe")}${ev.found.length ? ` (${tally(ev.found.map((f) => probeWords(f.probe)))})` : ""}${
        belief.adversary ? `; adversary ${belief.adversary.verdict}` : ""
      }`,
      [cite.belief(runId, belief.id), ...ev.found.map((f) => cite.probe(f.runId, f.probe))],
    );
  }
  if (!notarized.length) w.absent(`No ${tool} belief is notarized in the latest snapshots`);
  const others = all.filter((x) => x.belief.status !== "notarized");
  if (others.length) {
    w.say(
      `Other ${tool} beliefs (latest snapshots): ${tally(others.map((x) => x.belief.status))}`,
      others.map((x) => cite.belief(x.runId, x.belief.id)),
    );
  }

  // Probes.
  const probes = world.bundles.flatMap((b) => b.probes.filter((p) => p.tool === tool).map((p) => ({ probe: p, runId: b.runId })));
  if (probes.length) {
    w.say(
      `${plural(probes.length, "probe")} ran on ${tool} claims in this world; verdicts: ${tally(probes.map((x) => x.probe.verdict ?? "not run"))}; templates: ${tally(
        probes.map((x) => x.probe.template),
      )}`,
      probes.map((x) => cite.probe(x.runId, x.probe)),
    );
  } else {
    w.absent(`No probe ran on ${tool} claims in this world`);
  }

  // Guards compiled from this tool's beliefs (newest copy of each).
  const toolBeliefIds = new Set(all.map((x) => x.belief.id));
  const guards = new Map<string, { guard: Guard; runId: string }>();
  for (const b of world.bundles) for (const g of b.guards) if (toolBeliefIds.has(g.beliefId)) guards.set(g.id, { guard: g, runId: b.runId });
  if (guards.size) {
    const gs = [...guards.values()].sort((x, y) => (x.guard.id < y.guard.id ? -1 : 1));
    const act = gs.filter((x) => x.guard.active);
    const ret = gs.filter((x) => !x.guard.active);
    w.say(
      `Guards compiled from ${tool} beliefs: ${act.length} active${act.length ? ` (${tally(act.map((x) => x.guard.kind))})` : ""}, ${ret.length} retired${
        ret.length ? ` (${ret.map((x) => `${x.guard.id} at ${x.guard.retiredAt ?? "an unrecorded time"}`).join(", ")})` : ""
      }`,
      gs.map((x) => cite.guard(x.runId, x.guard)),
    );
  } else {
    w.absent(`No guard was compiled from ${tool} beliefs in this world`);
  }

  return w.build({
    id: toolKnowledgeId(world.key, tool),
    kind: "tool_knowledge",
    question: `What does Notary know about ${tool} (${shortWorld(world)})?`,
    sample: world.sample,
  });
}

// --- what changed between two runs? ---------------------------------------------------------------

export function runDiffId(a: string, b: string): string {
  return `run_diff:${a}:${b}`;
}

/**
 * What changed from run `a` to run `b` (same world only: fixture and real, or two fixture
 * scenarios, are never compared). null when neither run holds a citable record.
 */
export function runDiff(a: RunBundle, b: RunBundle, world: World = makeWorld([a, b])): ExplainAnswer | null {
  const ka = worldKeyOf(a);
  const kb = worldKeyOf(b);
  if (ka !== kb) throw new Error(`explain: refusing to compare runs from different worlds (${a.runId}: ${ka}, ${b.runId}: ${kb})`);
  if (ka !== world.key) throw new Error(`explain: runs ${a.runId}, ${b.runId} are not in world ${world.key}`);
  if (a.runId === b.runId) throw new Error("explain: a run diff needs two different runs");
  const w = new AnswerWriter(prefix(world));
  w.run(a.runId);
  w.run(b.runId);
  const name = (x: RunBundle): string => `${x.runId} (${x.kind}, ${x.variant})`;

  // Decisions, matched by queue request id.
  const da = new Map(a.decisions.map((d) => [d.requestId, d]));
  const db = new Map(b.decisions.map((d) => [d.requestId, d]));
  const both = [...db.keys()].filter((r) => da.has(r));
  const changed = both.filter((r) => da.get(r)!.status !== db.get(r)!.status);
  const same = both.filter((r) => da.get(r)!.status === db.get(r)!.status);
  const decisionCites = (rs: readonly string[]): Citation[] => rs.flatMap((r) => [cite.decision(a.runId, da.get(r)!), cite.decision(b.runId, db.get(r)!)]);
  if (!a.decisions.length && !b.decisions.length) {
    w.absent(`Neither ${a.runId} nor ${b.runId} records queue decisions`);
  } else if (!both.length) {
    w.absent(`${a.runId} and ${b.runId} share no queue item`);
  } else {
    if (changed.length) {
      w.say(
        `From ${name(a)} to ${name(b)}, ${changed.length} of ${both.length} queue items changed status: ${changed
          .map((r) => `${r} ${da.get(r)!.status} → ${db.get(r)!.status}`)
          .join(", ")}`,
        decisionCites(changed),
      );
      const moves = changed.map((r) => `${da.get(r)!.status} → ${db.get(r)!.status}`);
      w.say(`By transition: ${tally(moves)}`, decisionCites(changed));
    } else {
      w.say(`From ${name(a)} to ${name(b)}, none of the ${both.length} shared queue items changed status`, decisionCites(both));
    }
    if (same.length && changed.length) w.say(`${plural(same.length, "item")} kept ${same.length === 1 ? "its" : "their"} status: ${same.map((r) => `${r} ${db.get(r)!.status}`).join(", ")}`, decisionCites(same));
    const onlyA = [...da.keys()].filter((r) => !db.has(r));
    const onlyB = [...db.keys()].filter((r) => !da.has(r));
    if (onlyA.length) w.say(`Only in ${a.runId}: ${list(onlyA)}`, onlyA.map((r) => cite.decision(a.runId, da.get(r)!)));
    if (onlyB.length) w.say(`Only in ${b.runId}: ${list(onlyB)}`, onlyB.map((r) => cite.decision(b.runId, db.get(r)!)));
    // Graded unsafe actions, counted from the decisions' own grades.
    const unsafe = (x: RunBundle): string[] => x.decisions.flatMap((d) => d.grade?.unsafe ?? []);
    const graded = (x: RunBundle): Decision[] => x.decisions.filter((d) => d.grade);
    if (graded(a).length && graded(b).length) {
      const ua = unsafe(a);
      const ub = unsafe(b);
      w.say(
        `Unsafe actions in the decisions' grades: ${a.runId} ${ua.length}${ua.length ? ` (${tally(ua)})` : ""}, ${b.runId} ${ub.length}${ub.length ? ` (${tally(ub)})` : ""}`,
        [...graded(a).map((d) => cite.decision(a.runId, d)), ...graded(b).map((d) => cite.decision(b.runId, d))],
      );
    }
  }

  // Beliefs (end-of-run snapshots).
  const ba = new Map(a.beliefs.after.map((x) => [x.id, x]));
  const bb = new Map(b.beliefs.after.map((x) => [x.id, x]));
  if (!ba.size && !bb.size) {
    w.absent(`Neither run records a belief snapshot`);
  } else if (!ba.size || !bb.size) {
    const [has, none] = ba.size ? [a, b] : [b, a];
    const snap = has.beliefs.after;
    w.absent(`${none.runId} records no belief snapshot, so belief statuses cannot be compared`);
    w.say(`${has.runId} ends with ${plural(snap.length, "belief")}: ${tally(snap.map((x) => x.status))}`, snap.map((x) => cite.belief(has.runId, x.id)));
  } else {
    const ids = [...bb.keys()].filter((id) => ba.has(id)).sort();
    const moved = ids.filter((id) => ba.get(id)!.status !== bb.get(id)!.status);
    if (moved.length) {
      for (const id of moved) {
        const x = ba.get(id)!;
        const y = bb.get(id)!;
        w.say(`${claimOfBelief(id)}: ${x.status} → ${y.status} (P(doc claim holds) ${p4(x.confidence)} → ${p4(y.confidence)})`, [cite.belief(a.runId, id), cite.belief(b.runId, id)]);
      }
    } else {
      w.say(`None of the ${ids.length} beliefs in both snapshots changed status`, ids.flatMap((id) => [cite.belief(a.runId, id), cite.belief(b.runId, id)]));
    }
    const onlyB = [...bb.keys()].filter((id) => !ba.has(id)).sort();
    const onlyA = [...ba.keys()].filter((id) => !bb.has(id)).sort();
    if (onlyA.length) w.say(`Beliefs only in ${a.runId}: ${list(onlyA.map(claimOfBelief))}`, onlyA.map((id) => cite.belief(a.runId, id)));
    if (onlyB.length) w.say(`Beliefs only in ${b.runId}: ${list(onlyB.map(claimOfBelief))}`, onlyB.map((id) => cite.belief(b.runId, id)));
  }
  const events = b.beliefEvents.map((e, i) => ({ e, i })).filter((x) => x.e.from !== x.e.to && x.e.from !== null);
  for (const { e, i } of events) {
    w.say(`During ${b.runId}, ${claimOfBelief(e.beliefId)} went ${e.from} → ${e.to} at ${e.at}${e.probeId ? ` on probe ${e.probeId}` : ""}`, [cite.beliefEvent(b.runId, e.beliefId, i)]);
  }

  // Metrics, null-safe: a delta only when both runs computed the metric.
  const metricCites = [
    ...a.decisions.map((d) => cite.decision(a.runId, d)),
    ...b.decisions.map((d) => cite.decision(b.runId, d)),
  ];
  const keys = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])].sort();
  const deltas: string[] = [];
  const unchanged: string[] = [];
  const notComparable: string[] = [];
  for (const k of keys) {
    const x = a.metrics[k];
    const y = b.metrics[k];
    if (typeof x !== "number" || typeof y !== "number") {
      if (!(x === null && y === null) && !(x === undefined && y === undefined)) notComparable.push(k);
      continue;
    }
    if (Math.round((y - x) * 1e6) === 0) unchanged.push(k);
    else deltas.push(`${k} ${num(x)} → ${num(y)} (${signed(y - x)})`);
  }
  const metricText = [
    deltas.length ? `Metrics that changed: ${deltas.join(", ")}` : "No metric computed in both runs changed",
    unchanged.length ? `${plural(unchanged.length, "metric")} computed in both runs did not change` : "",
    notComparable.length ? `not comparable (computed in only one run): ${notComparable.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  if (!keys.length) w.absent("Neither run records metrics");
  else if (metricCites.length) w.say(metricText, metricCites);
  else w.absent(`${metricText} (run-level metrics; no per-item records to cite)`);

  // Guards.
  const ga = new Map(a.guards.map((g) => [g.id, g]));
  const gb = new Map(b.guards.map((g) => [g.id, g]));
  const added = [...gb.values()].filter((g) => !ga.has(g.id)).sort((x, y) => (x.id < y.id ? -1 : 1));
  const removed = [...ga.values()].filter((g) => !gb.has(g.id)).sort((x, y) => (x.id < y.id ? -1 : 1));
  const retired = [...gb.values()].filter((g) => !g.active && (ga.get(g.id)?.active ?? true)).sort((x, y) => (x.id < y.id ? -1 : 1));
  if (!ga.size && !gb.size) w.absent("Neither run records guards");
  if (added.length) w.say(`Guards in ${b.runId} and not in ${a.runId}: ${added.map((g) => `${g.id} (${g.kind} on ${g.operation}${g.active ? "" : ", retired"})`).join(", ")}`, added.map((g) => cite.guard(b.runId, g)));
  if (removed.length) w.say(`Guards in ${a.runId} and not in ${b.runId}: ${removed.map((g) => `${g.id} (${g.kind} on ${g.operation})`).join(", ")}`, removed.map((g) => cite.guard(a.runId, g)));
  for (const g of retired) {
    w.say(`Guard ${g.id} (${g.kind} on ${g.operation}, from ${g.beliefId}) is retired in ${b.runId}${g.retiredAt ? ` (retired at ${g.retiredAt})` : ""}`, [cite.guard(b.runId, g), ...(ga.has(g.id) ? [cite.guard(a.runId, ga.get(g.id)!)] : [])]);
  }
  if ((ga.size || gb.size) && !added.length && !removed.length && !retired.length) {
    w.say(`The ${plural(gb.size, "guard")} are the same in both runs`, [...gb.values()].map((g) => cite.guard(b.runId, g)));
  }

  if (!w.citationCount) return null;
  return w.build({
    id: runDiffId(a.runId, b.runId),
    kind: "run_diff",
    question: `What changed between ${a.runId} and ${b.runId}?`,
    sample: world.sample,
  });
}

// --- which certificates were revoked, and why? ----------------------------------------------------

export function revocationsId(worldKey: string): string {
  return `revocations:${worldKey}`;
}

/** Every revocation in the world's certificates. null when the world has no certificate at all. */
export function revocations(world: World): ExplainAnswer | null {
  const certs = world.certificates.flatMap((t) => t.certificates);
  const revs = world.certificates.flatMap((t) => t.revocations);
  if (!certs.length) return null;
  const w = new AnswerWriter(prefix(world));
  for (const c of certs) w.run(c.sourceBundle.runId);
  if (!revs.length) {
    w.say(`No certificate in ${shortWorld(world)} was revoked: all ${plural(certs.length, "issued certificate")} are active`, certs.map(cite.certificate));
  } else {
    w.say(`${plural(revs.length, "certificate")} of ${certs.length} issued in ${shortWorld(world)} ${revs.length === 1 ? "was" : "were"} revoked`, [...revs.map(cite.revocation), ...certs.map(cite.certificate)]);
  }
  for (const r of revs) {
    const c = certs.find((x) => x.id === r.certificateId);
    const rc = cite.revocation(r);
    w.say(
      `Certificate ${r.certificateId} (${r.tool} ${r.claimId}${c ? `, issued ${c.issuedAt} on the ${c.side === "honored" ? "matches-docs" : "contradicts-docs"} side` : ""}) was revoked at ${r.revokedAt} in run ${r.sourceBundle.runId}: belief ${claimOfBelief(r.beliefId)} went ${r.from} → ${r.to}, ${confidenceWords(r)}`,
      [rc, ...(c ? [cite.certificate(c)] : []), ...beliefCite(world, r.sourceBundle.runId, r.beliefId)],
    );
    w.say(`Recorded reason: ${quote(r.reason)}`, [rc]);
    const t = resolveProbes(world, r.triggerProbeIds);
    if (t.found.length) {
      w.say(
        `Trigger ${t.found.length === 1 ? "probe" : "probes"}: ${t.found.map((f) => `${f.probe.id} (${probeWords(f.probe)})`).join(", ")}`,
        [rc, ...t.found.map((f) => cite.probe(f.runId, f.probe))],
      );
    } else if (!r.triggerProbeIds.length) {
      w.say("The revocation names no trigger probe", [rc]);
    }
    if (t.missing.length) w.absent(`${plural(t.missing.length, "trigger probe id")} not in any published run of this world: ${list(t.missing)}`);
    if (r.triggerTraceIds.length) w.say(`Trigger ${r.triggerTraceIds.length === 1 ? "trace" : "traces"}: ${r.triggerTraceIds.join(", ")}`, [rc]);
    else w.absent("No trace id is recorded for its trigger probes");
    if (r.guardsRetired.length) {
      const gcs = r.guardsRetired.flatMap((g) => {
        const own = bundleIn(world, r.sourceBundle.runId)?.guards.find((x) => x.id === g.id);
        return own ? [cite.guard(r.sourceBundle.runId, own)] : [];
      });
      w.say(`Guards retired with it: ${r.guardsRetired.map((g) => `${g.id} (${g.kind} on ${g.operation}) at ${g.retiredAt}`).join(", ")}`, [rc, ...gcs]);
    } else {
      w.say("No guard was retired with it", [rc]);
    }
  }
  return w.build({
    id: revocationsId(world.key),
    kind: "revocations",
    question: `Which certificates were revoked, and why (${shortWorld(world)})?`,
    sample: world.sample,
  });
}

