import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateBundle } from "../src/data";
import {
  beliefBreakdown,
  comparable,
  insight,
  queueFlow,
  unsafeDelta,
} from "../src/analytics";
const read = (id: string) =>
  validateBundle(
    JSON.parse(
      readFileSync(
        new URL(`../public/bundles/fixture/${id}.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
const guarded = read("demo-run-guarded");
const naive = read("demo-run-naive");
describe("overview provenance and comparison", () => {
  it("refuses a mixed fixture/live delta", () => {
    const live = { ...naive, sample: false };
    expect(comparable(guarded, live)).toBe(false);
    expect(unsafeDelta(guarded, live)).toBeNull();
    expect(insight(guarded, live)).toContain("baseline is needed");
  });
  it("does not turn unavailable grading into zero", () => {
    expect(unsafeDelta({ ...guarded, metrics: {} }, naive)).toBeNull();
  });
  it("derives the safety delta and refund hold takeaway from actual records", () => {
    const difference =
      guarded.metrics.unsafe_actions_total! -
      naive.metrics.unsafe_actions_total!;
    expect(unsafeDelta(guarded, naive)).toBe(difference);
    const held = guarded.decisions.filter(
      (d) =>
        d.status === "held" &&
        d.missingBeliefs.length &&
        ["refund", "partial_refund"].includes(d.requestType),
    ).length;
    expect(insight(guarded, naive)).toContain(`${held} refund requests`);
    expect(insight(guarded, naive)).toContain(
      `${Math.abs(difference)} fewer unsafe actions`,
    );
  });
  it("counts each belief once even when downgrade and abstention overlap", () => {
    const rows = beliefBreakdown(guarded);
    expect(rows.every((r) => r.value >= 0)).toBe(true);
    expect(rows.reduce((sum, r) => sum + r.value, 0)).toBe(
      guarded.beliefs.after.length,
    );
  });
  it("preserves terminal branch counts and signed adjacent differences", () => {
    const rows = queueFlow(guarded);
    expect(rows[0].value).toBe(guarded.queue.length);
    for (const [i, status] of ["executed", "held", "escalated"].entries()) {
      expect(rows[i + 2].value).toBe(
        guarded.decisions.filter((d) => d.status === status).length,
      );
    }
    expect(rows[3].drop).toBe(rows[2].value - rows[3].value);
  });
});
