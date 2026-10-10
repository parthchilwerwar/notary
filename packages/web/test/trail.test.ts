import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BundleIndexSchema,
  CertificateReportSchema,
  FixtureIndexSchema,
} from "../../core/src/schema";
import type { RunBundle } from "../../core/src/schema";
import { validateBundle } from "../src/data";
import {
  chooseScenario,
  verifyToolFile,
  type CertificateWorld,
} from "../src/state/certificates";
import {
  classifySource,
  deriveCertificateTrail,
  deriveDecisionTrail,
  hypothesisSource,
  worldMatches,
  worldPool,
  type TrailLine,
  type TrailModel,
} from "../src/components/trail/model";

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8"));
const index = BundleIndexSchema.parse(read("bundles/fixture/index.json"));
const bundles: RunBundle[] = index.map((e) =>
  validateBundle(read(`bundles/fixture/${e.runId}.json`), e),
);
const byId = (id: string) => bundles.find((b) => b.runId === id)!;

/** Same as loadCertificateWorld, from disk. */
function world(runId: string): CertificateWorld {
  const fx = FixtureIndexSchema.parse(read("certificates/fixture/index.json"));
  const { scenario, reason } = chooseScenario(fx, runId)!;
  const dir = `certificates/fixture/${scenario.report.slice(0, scenario.report.lastIndexOf("/") + 1)}`;
  const report = CertificateReportSchema.parse(read(`${dir}report.json`));
  const tools = report.tools.map((t) =>
    verifyToolFile(read(`${dir}${t.file}`), report.toolFileHashes[t.file], true, t.file),
  );
  return {
    sample: true,
    scenario: scenario.scenario,
    scenarioReason: reason,
    report,
    tools,
    certificates: tools.flatMap((t) => t.certificates),
    revocations: tools.flatMap((t) => t.revocations),
    noCertificates: tools.flatMap((t) => t.noCertificates),
  };
}

/** Derives a trail for every decision of a run; CPU-bound, so it gets room when the machine is busy. */
const HEAVY = { timeout: 30_000 };

const allLines = (m: TrailModel): TrailLine[] =>
  m.steps.flatMap((s) => [...s.lines, ...s.groups.flatMap((g) => g.lines)]);

const changeApi = byId("demo-change-api-run-guarded");
const changeWorld = world(changeApi.runId);
const decisionFor = (b: RunBundle, requestId: string) =>
  b.decisions.find((d) => d.requestId === requestId)!;

describe("classifySource (the Model said / Verified rule)", () => {
  it("marks deterministic and observed sources Verified", () => {
    for (const s of [
      "request",
      "enrichment",
      "tier",
      "prediction",
      "observation",
      "verdict",
      "belief.math",
      "policy",
      "guard",
      "effect",
      "grade",
      "certificate",
      "revocation",
      "hypothesis.code",
    ])
      expect(classifySource(s)).toBe("verified");
  });
  it("marks model output, and anything unknown, Model said", () => {
    for (const s of [
      "adversary",
      "hypothesis.model",
      "scope.narrowed",
      "executor",
      "reflector",
      "something-new",
      "",
    ])
      expect(classifySource(s)).toBe("model");
  });
  it("only code-built verification rivals are Verified hypotheses", () => {
    expect(hypothesisSource({ anomalyId: "verify:dodo.refund.amount-minor-units" })).toBe(
      "hypothesis.code",
    );
    expect(hypothesisSource({ anomalyId: "anom-ec08f8ac8c77" })).toBe("hypothesis.model");
  });
});

describe("data world", () => {
  it("matches the change-api run to its own fixture scenario only", () => {
    expect(changeWorld.scenario).toBe("change-api");
    expect(worldMatches(changeWorld, changeApi)).toBe(true);
    expect(worldMatches(changeWorld, byId("demo-run-guarded"))).toBe(false);
    expect(worldMatches(changeWorld, { ...changeApi, sample: false })).toBe(false);
  });
  it("pools only same-scenario fixture bundles", () => {
    const pool = worldPool(changeApi, bundles, changeWorld).map((b) => b.runId);
    expect(pool[0]).toBe(changeApi.runId);
    expect(pool.every((id) => id.startsWith("demo-change-api-"))).toBe(true);
    expect(pool).toContain("demo-change-api-notarize-dodo");
  });
});

describe("DecisionTrail derivation", () => {
  const q10 = decisionFor(changeApi, "q10");
  const trail = deriveDecisionTrail({
    bundle: changeApi,
    decisionId: q10.id,
    bundles,
    world: changeWorld,
  })!;

  it("has the five steps in order", () => {
    expect(trail.steps.map((s) => s.key)).toEqual([
      "request",
      "context",
      "certificates",
      "evidence",
      "decision",
    ]);
    expect(trail.notes).toEqual([]);
  });

  it("held q10: the sentinel-revoked certificate is the deciding factor", () => {
    expect(q10.status).toBe("held");
    expect(q10.missingBeliefs).toEqual(["belief-dodo.refund.amount-minor-units"]);
    const revoked = changeWorld.certificates.find(
      (c) => c.beliefId === "belief-dodo.refund.amount-minor-units",
    )!;
    expect(revoked.status).toBe("revoked");
    expect(trail.decidedBy?.kind).toBe("revoked_certificate");
    expect(trail.decidedBy?.ids).toContain(revoked.id);
    expect(trail.decidedBy?.text).toContain("during this run");

    const certs = trail.steps.find((s) => s.key === "certificates")!;
    const line = certs.lines.find((l) => l.label === "belief-dodo.refund.amount-minor-units")!;
    expect(line.status).toBe("revoked");
    expect(line.decisive).toBe(true);
    expect(certs.lines.filter((l) => l.decisive)).toHaveLength(1);
    expect(certs.lines.filter((l) => l.status === "certified")).toHaveLength(
      q10.requiredBeliefs.length - 1,
    );

    const group = trail.steps
      .find((s) => s.key === "evidence")!
      .groups.find((g) => g.key === "belief-dodo.refund.amount-minor-units")!;
    expect(group.decisive).toBe(true);
    // Notarize probes (×100) and the sentinel's probes in this run (unchanged echo).
    const predictions = group.lines.filter((l) => l.source === "prediction");
    expect(predictions.map((l) => l.record?.id)).toEqual(
      expect.arrayContaining([
        "demo-change-api-notarize-dodo-p020",
        "demo-change-api-run-guarded-s006",
      ]),
    );
    expect(predictions.every((l) => l.detail?.includes("recomputed, matches"))).toBe(true);
    expect(predictions.every((l) => !l.warning)).toBe(true);
    expect(group.lines.some((l) => l.source === "revocation" && l.decisive)).toBe(true);
    expect(
      group.lines.some((l) => l.source === "belief.event" && l.status === "unlearned"),
    ).toBe(true);
    const adversary = group.lines.find((l) => l.source === "adversary")!;
    expect(adversary.tag).toBe("model");
    expect(adversary.detail).toContain("model fixture.adversary-double");
  });

  it("a held item's revocation is not described as after the decision", () => {
    const group = trail.steps[3].groups.find((g) => g.decisive)!;
    const rev = group.lines.find((l) => l.source === "revocation")!;
    expect(rev.detail).not.toContain("after this decision ran");
  });

  it("Verified lines never repeat the adversary's own words", HEAVY, () => {
    for (const b of bundles.filter((x) => x.kind === "run")) {
      const w = world(b.runId);
      const reasons = [...b.beliefs.after, ...bundles.flatMap((x) => x.beliefs.after)]
        .map((x) => x.adversary?.reason)
        .filter((r): r is string => !!r);
      for (const d of b.decisions) {
        const t = deriveDecisionTrail({ bundle: b, decisionId: d.id, bundles, world: w })!;
        for (const l of allLines(t))
          if (l.tag === "verified" && l.source === "belief.event")
            for (const r of reasons) expect(l.text.includes(r)).toBe(false);
      }
    }
  });

  it("request and context come from the records", () => {
    const req = trail.steps[0].lines;
    const request = changeApi.queue.find((r) => r.id === "q10")!;
    expect(req.find((l) => l.label === "Amount")!.text).toContain("2,500 USD");
    expect(req.find((l) => l.label === "Customer")!.text).toContain(request.companyDomain);
    const ctx = trail.steps[1].lines;
    expect(ctx[0].text).toBe("enterprise");
    expect(ctx[0].detail).toBe(`basis ${String(q10.enrichment!.tierBasis)}`);
    expect(ctx.find((l) => l.label === "headcountTotal")!.text).toBe("8,300");
  });

  it("executed item: the guard decided it", () => {
    const q01 = decisionFor(changeApi, "q01");
    expect(q01.status).toBe("executed");
    const t = deriveDecisionTrail({ bundle: changeApi, decisionId: q01.id, bundles, world: changeWorld })!;
    expect(t.decidedBy?.kind).toBe("guard");
    expect(t.decidedBy?.ids).toEqual(q01.guardsApplied);
    const guards = t.steps[4].lines.filter((l) => l.source === "guard");
    expect(guards.map((l) => l.key)).toEqual(q01.guardsApplied.map((g) => `guard-${g}`));
    expect(guards.every((l) => l.decisive && l.tag === "verified")).toBe(true);
  });

  it("guard-refused hold names the refusing guard", () => {
    const q02 = decisionFor(changeApi, "q02");
    const t = deriveDecisionTrail({ bundle: changeApi, decisionId: q02.id, bundles, world: changeWorld })!;
    expect(t.decidedBy).toMatchObject({ kind: "guard", ids: ["grd-4a311973a512"] });
  });

  it("an executed item before the revocation says the certificate was revoked afterwards", () => {
    const q09 = decisionFor(changeApi, "q09");
    const t = deriveDecisionTrail({ bundle: changeApi, decisionId: q09.id, bundles, world: changeWorld })!;
    const line = t.steps[2].lines.find((l) => l.label === "belief-dodo.refund.amount-minor-units")!;
    expect(line.status).toBe("revoked");
    expect(line.detail).toContain("after this decision ran");
    expect(line.decisive).toBe(false);
  });

  it("every line of every decision has exactly one tag; verified lines carry the record's trace id", HEAVY, () => {
    for (const b of bundles.filter((x) => x.kind === "run")) {
      const w = world(b.runId);
      for (const d of b.decisions) {
        const t = deriveDecisionTrail({ bundle: b, decisionId: d.id, bundles, world: w })!;
        for (const l of allLines(t)) {
          expect(["verified", "model"]).toContain(l.tag);
          expect(l.tag).toBe(classifySource(l.source));
          if (l.tag !== "verified") continue;
          // Lines about the decision record carry its trace id when it has one.
          if (l.record?.kind === "decision" && l.record.id === d.id && d.traceId)
            expect(l.traceId).toBe(d.traceId);
          // Probe lines carry the probe's trace id.
          if (l.record?.kind === "probe" && ["prediction", "observation", "verdict"].includes(l.source)) {
            const probe = bundles
              .find((x) => x.runId === l.record!.runId)!
              .probes.find((p) => p.id === l.record!.id)!;
            if (probe.traceId) expect(l.traceId).toBe(probe.traceId);
          }
          // Never an invented URL: only one recorded for that trace id.
          if (l.traceUrl) {
            const recorded = bundles.some(
              (x) =>
                x.traceLinks[l.traceId!] === l.traceUrl ||
                x.decisions.some((y) => y.evidencePack?.traceLinks[l.traceId!] === l.traceUrl),
            );
            expect(recorded).toBe(true);
          }
        }
      }
    }
  });

  it("never mixes worlds: a mismatched certificate world is ignored", () => {
    const t = deriveDecisionTrail({
      bundle: changeApi,
      decisionId: q10.id,
      bundles,
      world: world("demo-run-guarded"),
    })!;
    expect(t.notes[0]).toMatch(/different data world/);
    expect(t.steps[2].lines.every((l) => l.status === undefined)).toBe(true);
  });
});

describe("CertificateTrail derivation", () => {
  const revoked = changeWorld.certificates.find((c) => c.status === "revoked")!;
  const t = deriveCertificateTrail({
    certificateId: revoked.id,
    world: changeWorld,
    bundles,
    runId: changeApi.runId,
  })!;

  it("shows claim, scope, status, evidence and enforcement from the world's own bundles", () => {
    expect(t.steps.map((s) => s.title)).toEqual([
      "Claim",
      "Scope",
      "Certificate status",
      "Hypotheses, predictions, observations, verdicts",
      "Enforcement",
    ]);
    expect(t.notes).toEqual([]);
    const status = t.steps[2].lines;
    expect(status[0].status).toBe("revoked");
    expect(status.some((l) => l.source === "revocation")).toBe(true);
    const group = t.steps[3].groups[0];
    // Revoked: evidence read from the revoking run's belief (notarize + sentinel probes).
    expect(group.record?.runId).toBe("demo-change-api-run-guarded");
    expect(group.lines.filter((l) => l.source === "prediction").length).toBe(9);
    const held = t.steps[4].lines.filter((l) => l.decisive);
    expect(held.map((l) => l.record?.id)).toContain(decisionFor(changeApi, "q10").id);
  });

  it("every line has exactly one tag", () => {
    for (const w of [changeWorld, world("demo-run-guarded")])
      for (const c of w.certificates) {
        const m = deriveCertificateTrail({ certificateId: c.id, world: w, bundles })!;
        for (const l of allLines(m)) expect(l.tag).toBe(classifySource(l.source));
        // Fixture worlds never pull in bundles of another scenario.
        for (const l of allLines(m))
          if (l.record?.runId)
            expect(l.record.runId.startsWith("demo-change-api-")).toBe(
              w.scenario === "change-api",
            );
      }
  });
});

describe("graded unsafe actions", () => {
  it("the naive run's unsafe decisions carry a red Grade line and a model-level flag, matching the run metric", HEAVY, () => {
    const naive = byId("demo-run-naive");
    let flagged = 0;
    for (const d of naive.decisions) {
      const t = deriveDecisionTrail({ bundle: naive, decisionId: d.id, bundles, world: world(naive.runId) })!;
      const grade = t.steps[4].lines.find((l) => l.source === "grade")!;
      const unsafe = d.grade?.unsafe ?? [];
      if (unsafe.length) {
        flagged += unsafe.length;
        expect(grade.status).toBe("unsafe");
        expect(grade.tag).toBe("verified");
        expect(grade.warning).toContain(unsafe[0]!.replaceAll("_", " "));
        expect(t.unsafe).toEqual(unsafe.map((u) => u.replaceAll("_", " ")));
      } else {
        expect(grade.status).toBeUndefined();
        expect(grade.warning).toBeUndefined();
        expect(t.unsafe).toBeUndefined();
      }
    }
    expect(flagged).toBe(naive.metrics.unsafe_actions_total);
  });

  it("guarded runs have no unsafe flags", HEAVY, () => {
    for (const b of [byId("demo-run-guarded"), changeApi])
      for (const d of b.decisions) {
        const t = deriveDecisionTrail({ bundle: b, decisionId: d.id, bundles, world: world(b.runId) })!;
        expect(t.unsafe).toBeUndefined();
      }
  });
});
