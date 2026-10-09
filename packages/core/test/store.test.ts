import { afterEach, describe, expect, it } from "vitest";
import { NotaryDb, PredictionImmutableError, predictionHash } from "../src/store/db.js";
import type { ProbeCommit } from "../src/store/db.js";

const dbs: NotaryDb[] = [];
function freshDb(): NotaryDb {
  const db = new NotaryDb(":memory:");
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

function commit(over: Partial<ProbeCommit> = {}): ProbeCommit {
  return {
    id: "run-1-p001",
    runId: "run-1",
    tool: "dodo",
    claimId: "dodo.product.price-minor-units",
    hypothesisIds: ["hyp-a", "hyp-b"],
    template: "unit_roundtrip",
    params: { steps: [], sent: 1234 },
    control: { params: { steps: [], sent: 2468 } },
    prediction: { "hyp-a": { class: "honored", outcomes: ["equal"] }, "hyp-b": { class: "unit_mismatch", outcomes: ["div100", "x100"] } },
    committedAt: "2026-10-10T10:00:00.000Z",
    traceId: "",
    ...over,
  };
}

const RESULT = {
  observed: { outcome: "equal" },
  controlObserved: { echoed: 2468 },
  verdict: "confirmed" as const,
  winningHypothesisId: "hyp-a",
  ranAt: "2026-10-10T10:00:01.000Z",
  costCredits: 0,
  calls: 2,
};

describe("store: probes", () => {
  it("commitProbe writes prediction, hash and committedAt; loadProbes returns schema-valid probes", () => {
    const db = freshDb();
    const p = commit();
    const hash = db.commitProbe(p);
    expect(hash).toBe(predictionHash(p.prediction));
    expect(db.isCommitted(p.id)).toBe(true);
    expect(db.committedAt(p.id)).toBe(p.committedAt);
    let [probe] = db.loadProbes("run-1");
    expect(probe).toMatchObject({ id: p.id, predictionHash: hash, committedAt: p.committedAt, prediction: p.prediction });
    expect(probe!.verdict).toBeUndefined();

    db.recordResult(p.id, hash, RESULT);
    [probe] = db.loadProbes("run-1");
    expect(probe).toMatchObject({
      verdict: "confirmed",
      winningHypothesisId: "hyp-a",
      observed: { outcome: "equal" },
      control: { params: { sent: 2468 }, observed: { echoed: 2468 } },
      ranAt: RESULT.ranAt,
      calls: 2,
    });
    expect(db.loadProbes("other-run")).toEqual([]);
  });

  it("an SQL trigger rejects any UPDATE of prediction_json / prediction_hash / committed_at", () => {
    const db = freshDb();
    db.commitProbe(commit());
    const attempts = [
      `UPDATE probes SET prediction_json = '{"hyp-a":{"class":"honored","outcomes":["x100"]}}'`,
      `UPDATE probes SET prediction_hash = '${"0".repeat(64)}'`,
      `UPDATE probes SET committed_at = '2026-10-10T11:00:00.000Z'`,
      `UPDATE probes SET params_json = '{}'`,
      `UPDATE probes SET template = 'type_edge'`,
    ];
    for (const sql of attempts) expect(() => db.db.exec(sql)).toThrow(/immutable/);
    expect(() => db.db.exec("DELETE FROM probes")).toThrow(/cannot be deleted/);
    // the prediction is unchanged
    expect(db.loadProbes("run-1")[0]!.prediction).toEqual(commit().prediction);
  });

  it("recordResult refuses when the stored prediction no longer matches its hash", () => {
    const db = freshDb();
    const hash = db.commitProbe(commit());
    // Tamper behind the trigger's back.
    db.db.exec("DROP TRIGGER probes_prediction_immutable");
    db.db.exec(`UPDATE probes SET prediction_json = '{"hyp-a":{"class":"honored","outcomes":["x100"]}}'`);
    expect(() => db.recordResult("run-1-p001", hash, RESULT)).toThrow(PredictionImmutableError);
    expect(db.loadProbes("run-1")[0]!.verdict).toBeUndefined();
  });

  it("recordResult refuses a hash other than the committed one, and a second result", () => {
    const db = freshDb();
    const hash = db.commitProbe(commit());
    expect(() => db.recordResult("run-1-p001", "f".repeat(64), RESULT)).toThrow(PredictionImmutableError);
    db.recordResult("run-1-p001", hash, RESULT);
    expect(() => db.recordResult("run-1-p001", hash, { ...RESULT, verdict: "refuted", winningHypothesisId: undefined } as never)).toThrow(
      /already recorded/,
    );
    expect(() => db.recordResult("never-committed", hash, RESULT)).toThrow(/never committed/);
  });

  it("anomalies and hypotheses round-trip per run", () => {
    const db = freshDb();
    db.saveAnomalies("run-1", [
      { id: "anom-1", claimId: "c1", tool: "dodo", observed: { status: 200 }, expected: { status: 422 }, exchangeId: "x", traceId: "", spanId: "" },
    ]);
    db.saveHypotheses("run-1", [
      { id: "hyp-1", anomalyId: "anom-1", class: "honored", statement: "s", distinguishingTest: "unknown_param" },
    ]);
    expect(db.loadAnomalies("run-1")).toHaveLength(1);
    expect(db.loadHypotheses("run-1")[0]).toMatchObject({ id: "hyp-1", class: "honored" });
  });
});
