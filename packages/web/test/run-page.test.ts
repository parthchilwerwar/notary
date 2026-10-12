// R3: the Run page's pure logic against the real published fixture timelines and bundles, read
// through the data layer (ReplaySource over packages/web/public/, hash-verified).
import { existsSync, readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRecord, ApprovalsList, Certificate, RunBundle, TimelineEvent } from "../../core/src/schema";
import {
  DataSourceProvider,
  LiveSource,
  PublishedFiles,
  ReplayOnlyError,
  ReplaySource,
  REPLAY_MIN_STEP_MS,
  TimelineMissingError,
  approvalId,
  toCertificateView,
  type CertificateView,
  type RunEntry,
  type Timers,
} from "../src/data";
import { certificateScopeLines, classifySource } from "../src/components/trail/model";
import {
  FAILED_RUN_STATUSES,
  INITIAL_FOLLOW,
  REPLAY_SPEEDS,
  STAGES,
  afterRowsAdded,
  afterScroll,
  budgetView,
  buildRows,
  certificatesTouched,
  groupRuns,
  heldCard,
  isAtBottom,
  jumpToLatest,
  mergeEvents,
  moneyText,
  parseSpeed,
  pickRun,
  rowDetails,
  runControls,
  stageProgress,
  unsafeDecisionIds,
  type RunRow,
} from "../src/pages/run/model";
import {
  HeldCardView,
  TranscriptRow,
  TranscriptRows,
  TranscriptTimeline,
  clockTime,
  filterCounts,
  matchesFilter,
  moneyOf,
  parseView,
  transcriptGroups,
} from "../src/pages/run/Transcript";
import { RunPage } from "../src/pages/run/RunPage";

const PUBLIC = new URL("../public/", import.meta.url);
function diskFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\//, "");
    const file = new URL(path, PUBLIC);
    if (!existsSync(file)) return new Response("", { status: 404 });
    return new Response(readFileSync(file, "utf8"), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** Timers the test drives: records every delay, fires on demand. */
function manualTimers() {
  const queue: { fn: () => void; ms: number }[] = [];
  const timers: Timers = {
    set: (fn, ms) => {
      queue.push({ fn, ms });
      return queue.length;
    },
    clear: () => {},
  };
  return { timers, queue };
}

const replay = (timers?: Timers) => new ReplaySource({ published: new PublishedFiles({ base: "/", fetchImpl: diskFetch() }), timers });
const source = replay();
const runs = await source.listRuns();
const fixtureRuns = runs.filter((r): r is RunEntry & { state: "finished" } => r.state === "finished" && r.sample);

type Loaded = { entry: RunEntry; bundle: RunBundle; events: TimelineEvent[]; world: CertificateView | null };
const loaded = new Map<string, Loaded>();
const noTimeline: string[] = [];
for (const entry of fixtureRuns) {
  const events = await source.getTimeline(entry.runId).catch((e: unknown) => {
    if (e instanceof TimelineMissingError) return null;
    throw e;
  });
  if (!events) {
    noTimeline.push(entry.runId);
    continue;
  }
  const [bundle, world] = await Promise.all([source.getRun(entry.runId), source.certificates(entry)]);
  loaded.set(entry.runId, { entry, bundle, events, world: toCertificateView(world) });
}
const get = (id: string) => loaded.get(id)!;
const rowsOf = (l: Loaded) => buildRows(l.events, { bundle: l.bundle, world: l.world });
const allLines = (r: RunRow, l: Loaded) => {
  const d = rowDetails(r, { bundle: l.bundle, world: l.world });
  return [...(d.compare ? [...d.compare.left.lines, ...d.compare.right.lines] : []), ...d.lines];
};
const HEAVY = { timeout: 30_000 };

describe("fixture data under test", () => {
  it("covers every published fixture run (queue and notarize, both scenarios)", () => {
    expect(loaded.size).toBe(8);
    // The synthetic sample bundle has no timeline; the page shows "No timeline is published".
    expect(noTimeline).toEqual(["sample-42"]);
    for (const id of ["demo-run-guarded", "demo-change-api-run-guarded", "demo-notarize-dodo", "demo-run-naive"])
      expect(loaded.has(id)).toBe(true);
  });
});

describe("rows: titles derived from data", () => {
  it("one row per event, in seq order, plus one opening row read from the bundle", () => {
    for (const l of loaded.values()) {
      const rows = rowsOf(l);
      expect(rows.filter((r) => r.seq !== null).map((r) => r.seq)).toEqual(l.events.map((e) => e.seq));
      const intro = rows.filter((r) => r.type === "intro");
      expect(intro).toHaveLength(1);
      expect(intro[0]!.title).toContain(
        l.bundle.kind === "notarize" ? `${l.bundle.claims.length} documented claims` : `${l.bundle.queue.length} requests`,
      );
    }
  });

  it("decision titles name the recorded request, status and amount or missing certificate", () => {
    for (const l of loaded.values())
      for (const r of rowsOf(l).filter((x) => x.type === "decision")) {
        const d = l.bundle.decisions.find((x) => x.id === r.decisionId)!;
        expect(r.title).toContain(d.requestId);
        expect(r.title).toContain(d.status);
        if (d.status === "executed" && r.event?.data?.amount !== undefined)
          expect(r.title).toContain(moneyText(r.event.data.amount as number, r.event.data.currency as string));
        for (const b of d.status !== "executed" ? d.missingBeliefs : []) {
          const claim = l.bundle.beliefs.after.find((x) => x.id === b)?.claimId ?? b.replace(/^belief-/, "");
          expect(r.title).toContain(claim);
        }
      }
    const q10 = rowsOf(get("demo-change-api-run-guarded")).find((r) => r.title.startsWith("Partial refund q10"))!;
    expect(q10.title).toBe("Partial refund q10 held — no certificate for dodo.refund.amount-minor-units");
  });

  it("probe, adversary and certificate titles come from the records (tool, observation, model, scope)", () => {
    const l = get("demo-notarize-dodo");
    const rows = rowsOf(l);
    const verdicts = rows.filter((r) => r.type === "probe.verdict");
    expect(verdicts.length).toBe(l.bundle.probes.filter((p) => p.verdict).length);
    for (const r of verdicts) {
      const probe = l.bundle.probes.find((p) => p.id === r.event!.recordIds[0])!;
      expect(r.title.startsWith("Called Dodo — observed: ")).toBe(true);
      expect(r.subject).toContain(probe.claimId);
      expect(r.cost).toBe(`${probe.costCredits} credit${probe.costCredits === 1 ? "" : "s"} · ${probe.calls} call${probe.calls === 1 ? "" : "s"}`);
      expect(r.actor).toEqual({ kind: "tool", name: "Dodo" });
    }
    for (const r of rows.filter((x) => x.type === "adversary.verdict")) {
      const model = r.event!.data!.model as string;
      expect(r.title).toContain(`Adversary (${model}) challenged`);
      expect(r.actor).toEqual({ kind: "model", name: model });
    }
    for (const r of rows.filter((x) => x.type === "certificate.issued")) {
      const cert = l.world!.certificates.find((c) => c.id === r.certificateId)!;
      expect(r.title).toContain(`Certificate issued — ${cert.claimId} (scope: ${cert.scope.asProbed.operations.join(", ")}`);
      expect(r.tone).toBe("safe");
    }
  });

  it("titles change with the data (nothing typed): a different request id and amount give a different title", () => {
    const l = get("demo-change-api-run-guarded");
    const e = l.events.find((x) => x.type === "decision" && x.data?.status === "executed")!;
    const edited: TimelineEvent = { ...e, recordIds: ["x"], data: { ...e.data, requestId: "q999", amount: 12345 } };
    const [row] = buildRows([edited]);
    expect(row!.title).toContain("q999");
    expect(row!.title).toMatch(/USD\s123\.45/);
  });

  it("no model is assumed: without a recorded model the adversary row says so", () => {
    const e = get("demo-notarize-dodo").events.find((x) => x.type === "adversary.verdict")!;
    const [row] = buildRows([{ ...e, data: { ...e.data, model: undefined } }]);
    expect(row!.title).not.toContain("(");
    expect(row!.actor.name).toBe("model not recorded");
  });

  it("unsafe decisions are red x rows naming the grade; held are amber; committed probes spin until their verdict", () => {
    const naive = get("demo-run-naive");
    const unsafe = rowsOf(naive).filter((r) => r.tone === "unsafe");
    expect(unsafe.length).toBe(unsafeDecisionIds(naive.bundle).size);
    for (const r of unsafe) expect(r.subject).toMatch(/^graded unsafe: /);
    for (const r of rowsOf(get("demo-run-guarded")).filter((x) => x.event?.data?.status === "held"))
      expect([r.mark, r.tone]).toEqual(["x", "held"]);
    const l = get("demo-notarize-crustdata");
    const firstCommit = l.events.findIndex((e) => e.type === "probe.committed");
    const partial = buildRows(l.events.slice(0, firstCommit + 1), { bundle: l.bundle });
    expect(partial.at(-1)!.mark).toBe("spinner");
    const done = buildRows(l.events.slice(0, firstCommit + 2), { bundle: l.bundle });
    expect(done.find((r) => r.seq === l.events[firstCommit]!.seq)!.mark).toBe("check");
  });
});

describe("details: every statement tagged, Verified only when code checked it", () => {
  it("every detail line of every row carries the tag classifySource gives its source", HEAVY, () => {
    for (const l of loaded.values())
      for (const r of rowsOf(l)) for (const line of allLines(r, l)) expect(line.tag).toBe(classifySource(line.source));
  });

  it("adversary words only ever appear on Model said lines", HEAVY, () => {
    for (const l of loaded.values()) {
      const reasons = [...l.bundle.beliefs.after, ...l.bundle.beliefs.before].flatMap((b) => (b.adversary ? [b.adversary.reason] : []));
      const narrowed = (l.world?.certificates ?? []).flatMap((c) => (c.scope.narrowed ? [c.scope.narrowed.text] : []));
      for (const r of rowsOf(l))
        for (const line of allLines(r, l))
          if (line.tag === "verified")
            for (const words of [...reasons, ...narrowed].filter((w) => w.length > 12)) expect(line.text).not.toContain(words);
      for (const r of rowsOf(l).filter((x) => x.type === "adversary.verdict")) {
        const review = allLines(r, l).find((x) => x.key === "review");
        if (review) expect(review.tag).toBe("model");
      }
    }
  });

  it("a probe verdict shows the committed prediction beside the observation, hash recomputed", () => {
    const l = get("demo-notarize-dodo");
    const r = rowsOf(l).find((x) => x.type === "probe.verdict")!;
    const d = rowDetails(r, { bundle: l.bundle, world: l.world });
    expect(d.compare!.left.title).toBe("Predicted (committed first)");
    expect(d.compare!.right.lines[0]!.source).toBe("observation");
    const commitment = d.compare!.left.lines.find((x) => x.key === "pred-hash")!;
    expect(commitment.text).toContain("(recomputed, matches)");
    expect(commitment.warning).toBeUndefined();
    // Reflector hypotheses are model output.
    expect(d.compare!.left.lines.some((x) => x.source === "hypothesis.model" && x.tag === "model")).toBe(true);
  });

  it("a decision lists its request, policy, required certificates and every recorded call", () => {
    const l = get("demo-change-api-run-guarded");
    const r = rowsOf(l).find((x) => x.title.startsWith("Partial refund q10"))!;
    const d = l.bundle.decisions.find((x) => x.id === r.decisionId)!;
    const lines = allLines(r, l);
    expect(lines.filter((x) => x.source === "effect")).toHaveLength(d.effects.length);
    const needs = lines.find((x) => x.label === "Needs dodo.refund.amount-minor-units")!;
    expect(needs.status).toBe("revoked");
    expect(needs.decisive).toBe(true);
  });

  it("H-20: an unparsed narrowed scope never claims guards block — it names guard records, or says none exist", () => {
    const l = get("demo-change-api-notarize-dodo");
    const base = l.world!.certificates.find((c) => c.scope.narrowed)!;
    const unparsed: Certificate = { ...base, scope: { ...base.scope, narrowed: { ...base.scope.narrowed!, parsed: null } } };
    const none = certificateScopeLines(unparsed, []).at(-1)!;
    expect(none.source).toBe("record");
    expect(none.text).toContain("no guard record for this belief is published");
    expect(none.text).not.toMatch(/guards block/);
    const guarded = get("demo-change-api-run-guarded").bundle;
    const withGuard = { ...guarded, guards: [{ ...guarded.guards[0]!, beliefId: base.beliefId }] };
    const named = certificateScopeLines(unparsed, [withGuard]).at(-1)!;
    expect(named.source).toBe("guard");
    expect(named.text).toContain(guarded.guards[0]!.id);
    // The scope sentence quotes the adversary: those words are cut from the Verified line.
    const scope = certificateScopeLines(base, [])[0]!;
    expect(scope.tag).toBe("verified");
    expect(scope.text).not.toContain(base.scope.narrowed!.text);
    expect(certificateScopeLines(base, []).find((x) => x.source === "scope.narrowed")!.tag).toBe("model");
  });
});

describe("held cards", () => {
  const l = get("demo-run-guarded");
  const rows = rowsOf(l);
  const held = rows.filter((r) => r.held);

  it("exist only for held decisions", () => {
    expect(held.length).toBe(l.bundle.decisions.filter((d) => d.status === "held").length);
    for (const r of rows) {
      const card = heldCard(r, { mode: "replay", sample: true, bundle: l.bundle, world: l.world, approvals: null });
      expect(card !== null).toBe(r.type === "decision" && r.event?.data?.status === "held");
    }
  });

  it("replay: read-only with the reason and why (no actions)", async () => {
    const approvals = await source.approvals();
    const card = heldCard(held[0]!, { mode: "replay", sample: true, bundle: l.bundle, world: l.world, approvals })!;
    expect(card.kind).toBe("readonly");
    if (card.kind !== "readonly") return;
    expect(card.why).toBe(new ReplayOnlyError("Approving or rejecting a held action").message);
    expect(card.reason).toBe(approvals.pending.find((p) => p.decisionId === held[0]!.decisionId)!.reason);
    expect(card.evidence[0]).toContain("dodo.payments.page-size-max-100");
    const html = renderToStaticMarkup(createElement(HeldCardView, { card }));
    expect(html).not.toContain("Approve");
    expect(html).toContain("<code>pnpm notary serve</code>");
  });

  it("live: fixture runs stay read-only; a real pending item is actionable; decided and non-test-mode are not", () => {
    const row = held[0]!;
    const ctx = { mode: "live" as const, bundle: l.bundle, world: l.world };
    const pending = { runId: l.bundle.runId, decisionId: row.decisionId!, requestId: "q01", action: "dodo.createRefund", reason: "held", missingBeliefs: [], amount: 2900, currency: "USD" };
    const list = (over: Partial<ApprovalsList> = {}): ApprovalsList => ({ testMode: true, pending: [pending], decided: [], ...over });
    expect(heldCard(row, { ...ctx, sample: true, approvals: list() })!.kind).toBe("readonly");
    const actionable = heldCard(row, { ...ctx, sample: false, approvals: list() })!;
    expect(actionable.kind).toBe("actionable");
    if (actionable.kind === "actionable") {
      expect(actionable.id).toBe(approvalId(l.bundle.runId, row.decisionId!));
      expect(actionable.amountText).toMatch(/^USD\s29\.00$/);
      expect(renderToStaticMarkup(createElement(HeldCardView, { card: actionable }))).toContain("Approve…");
    }
    expect(heldCard(row, { ...ctx, sample: false, approvals: list({ testMode: false }) })!.kind).toBe("readonly");
    expect(heldCard(row, { ...ctx, sample: false, approvals: null, approvalsError: "nope" })).toMatchObject({ kind: "readonly", why: "nope" });
    const record = { id: "appr-x", runId: l.bundle.runId, decisionId: row.decisionId!, decision: "rejected", status: "closed" } as ApprovalRecord;
    expect(heldCard(row, { ...ctx, sample: false, approvals: list({ pending: [], decided: [record] }) })!.kind).toBe("decided");
  });
});

describe("stage progress", () => {
  it("highlights the latest event's stage while running, none once finished", () => {
    const l = get("demo-change-api-run-guarded");
    for (let n = 1; n < l.events.length; n++) {
      const p = stageProgress(l.events.slice(0, n));
      expect(p.current).toBe(l.events[n - 1]!.stage);
      expect(p.steps.filter((s) => s.current).map((s) => s.stage)).toEqual([l.events[n - 1]!.stage]);
      expect(p.steps.find((s) => s.current)!.state).toBe("active");
    }
    const end = stageProgress(l.events);
    expect(end.finished).toBe(true);
    expect(end.current).toBeNull();
    expect(end.steps.map((s) => s.stage)).toEqual([...STAGES]);
    expect(end.steps.map((s) => s.count)).toEqual(STAGES.map((s) => l.events.filter((e) => e.stage === s).length));
    expect(end.steps.find((s) => s.stage === "challenge")!.state).toBe("idle");
  });

  it("marks a stage alert for graded-unsafe decisions only (the naive run's Enforce)", () => {
    const naive = get("demo-run-naive");
    const p = stageProgress(naive.events, unsafeDecisionIds(naive.bundle));
    const enforce = p.steps.find((s) => s.stage === "enforce")!;
    expect(enforce.state).toBe("alert");
    expect(enforce.alerts).toEqual([`${unsafeDecisionIds(naive.bundle).size} unsafe actions`]);
    const guarded = get("demo-run-guarded");
    expect(stageProgress(guarded.events, unsafeDecisionIds(guarded.bundle)).steps.every((s) => s.state !== "alert")).toBe(true);
    expect([...FAILED_RUN_STATUSES].sort()).toEqual(["blocked", "failed", "stopped_budget"]);
  });
});

describe("replay speeds through the data layer", () => {
  it("instant delivers the whole recorded timeline at once, then ends", async () => {
    const got: TimelineEvent[] = [];
    let ended = false;
    await new Promise<void>((resolve) =>
      replay().streamEvents("demo-run-guarded", (e) => got.push(e), {
        speed: "instant",
        onEnd: () => {
          ended = true;
          resolve();
        },
      }),
    );
    expect(ended).toBe(true);
    expect(got).toEqual(get("demo-run-guarded").events);
    expect(buildRows(got, { bundle: get("demo-run-guarded").bundle })).toEqual(rowsOf({ ...get("demo-run-guarded"), world: null }));
  });

  it("1× and 4× wait the clamped recorded gaps, 4× four times shorter", async () => {
    for (const speed of [1, 4] as const) {
      const { timers, queue } = manualTimers();
      const got: TimelineEvent[] = [];
      replay(timers).streamEvents("demo-change-api-run-guarded", (e) => got.push(e), { speed });
      await vi.waitFor(() => expect(queue.length).toBe(1));
      expect(queue[0]!.ms).toBe(REPLAY_MIN_STEP_MS / speed);
      expect(got).toHaveLength(0);
      queue[0]!.fn();
      expect(got).toHaveLength(1);
      expect(stageProgress(got).current).toBe(got[0]!.stage);
    }
    expect(REPLAY_SPEEDS).toEqual([1, 4, "instant"]);
    expect([parseSpeed(null), parseSpeed("4"), parseSpeed("instant"), parseSpeed("8")]).toEqual([1, 4, "instant", 1]);
  });

  it("live merges: a provisional event never replaces a final one; a final one supersedes it", () => {
    const e = get("demo-run-guarded").events[0]!;
    const live: TimelineEvent = { ...e, summary: "provisional", data: { ...e.data, live: true } };
    expect(mergeEvents([], [live], e.runId)[0]!.summary).toBe("provisional");
    expect(mergeEvents([live], [e], e.runId)[0]).toEqual(e);
    expect(mergeEvents([e], [live], e.runId)[0]).toEqual(e);
    expect(mergeEvents([], [{ ...e, runId: "other" }], e.runId)).toEqual([]);
    expect(buildRows([live])[0]!.provisional).toBe(true);
  });
});

describe("budget", () => {
  it("unknown prices are unknown, never $0; a cap nobody recorded is 'no cap recorded'", () => {
    const l = get("demo-notarize-dodo");
    const v = budgetView(l.events, l.bundle.usageByRole)!;
    const calls = l.bundle.usageByRole.reflector.calls + l.bundle.usageByRole.adversary.calls;
    expect(v.usd.unknown).toBe(true);
    expect(v.usd.text).toBe(`unknown — ${calls} model calls without a recorded price`);
    expect(v.usd.capText).toBe("no cap recorded");
    const snap = l.events.find((e) => e.type === "budget")!.data!.budget as { credits: { used: number } };
    expect(v.credits.used).toBe(snap.credits.used);
    // A run with no model calls records a real $0.
    const q = get("demo-run-guarded");
    expect(budgetView(q.events, q.bundle.usageByRole)!.usd.text).toBe("$0.00 recorded");
    // Before the snapshot arrives there is no budget to show.
    expect(budgetView(q.events.slice(0, 3))).toBeNull();
  });

  it("shows the USD cap only when the snapshot records one", () => {
    const e = get("demo-run-guarded").events.find((x) => x.type === "budget")!;
    const capped = { ...e, data: { budget: { ...(e.data!.budget as object), usdCap: 0.5 } } };
    expect(budgetView([capped])!.usd.capText).toBe("of $0.50 (NOTARY_MAX_USD)");
  });
});

describe("certificates rail", () => {
  it("lists certificates the run issued or revoked so far, with their status in the run's own world", () => {
    const l = get("demo-change-api-run-guarded");
    const touched = certificatesTouched(l.events, l.world);
    const revoked = l.events.filter((e) => e.type === "certificate.revoked").map((e) => e.data!.certificateId);
    expect(touched.map((t) => t.id)).toEqual(revoked);
    expect(touched[0]).toMatchObject({ inRun: "revoked", current: "revoked", claimId: "dodo.refund.amount-minor-units" });
    expect(certificatesTouched(l.events.slice(0, 2), l.world)).toEqual([]);
    const n = get("demo-notarize-dodo");
    expect(certificatesTouched(n.events, n.world).length).toBe(n.events.filter((e) => e.type === "certificate.issued").length);
  });
});

describe("auto-scroll", () => {
  const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 500 });
  it("follows until the user scrolls up, counts new rows, and jumps back", () => {
    expect(isAtBottom(at(1500))).toBe(true);
    expect(isAtBottom(at(1400))).toBe(false);
    let s = afterRowsAdded(INITIAL_FOLLOW, 3);
    expect(s).toEqual(INITIAL_FOLLOW);
    s = afterScroll(s, at(900), 1500);
    expect(s.follow).toBe(false);
    s = afterRowsAdded(s, 2);
    expect(s).toEqual({ follow: false, unseen: 2 });
    // Re-measuring or scrolling down without reaching the bottom keeps the state.
    expect(afterScroll(s, at(1000), 900)).toEqual(s);
    expect(afterScroll(s, at(1500), 1000)).toEqual(INITIAL_FOLLOW);
    expect(jumpToLatest()).toEqual(INITIAL_FOLLOW);
  });
});

describe("runs and controls", () => {
  it("groups real and fixture runs apart and picks ?run= or the newest real run", () => {
    const real: RunEntry = { runId: "live-1", state: "running", kind: "run", startedAt: "2026-10-11T00:00:00.000Z" };
    const g = groupRuns([real, ...runs]);
    expect(g.real.map((r) => r.runId)).toEqual(["live-1", ...runs.filter((r) => r.state === "finished" && !r.sample).map((r) => r.runId)]);
    expect(g.fixture.every((r) => r.state === "finished" && r.sample)).toBe(true);
    expect(pickRun(runs, "demo-run-guarded")!.runId).toBe("demo-run-guarded");
    expect(pickRun([real, ...runs], null)!.runId).toBe("live-1");
    expect(pickRun(fixtureRuns, "missing")!.runId).toBe(fixtureRuns[0]!.runId);
  });

  it("live-only controls are absent in replay", () => {
    const fixture = fixtureRuns[0];
    const r = runControls("replay", fixture);
    expect(r.start.visible).toBe(false);
    expect(r.start.note).toBe(new ReplayOnlyError("Starting a run").message);
    expect(r.approvals.actionable).toBe(false);
    expect(r.speed.visible).toBe(true);
    const live = runControls("live", { runId: "x", state: "running", kind: "run", startedAt: "2026-10-11T00:00:00.000Z" });
    expect(live.start.visible).toBe(true);
    expect(live.speed.visible).toBe(false);
    expect(runControls("live", fixture).speed.visible).toBe(true);
    expect(runControls("live", fixture).approvals.actionable).toBe(false);
  });

  it("the rendered page offers Start Run only in live mode", () => {
    const render = (s: ReplaySource | LiveSource) =>
      renderToStaticMarkup(
        createElement(MemoryRouter, { initialEntries: ["/app/run?run=demo-run-guarded"] }, createElement(DataSourceProvider, { value: { source: s }, children: createElement(RunPage) })),
      );
    const replayHtml = render(source);
    expect(replayHtml).not.toContain("Start Run");
    expect(replayHtml).toContain("Starting a run needs live mode");
    // Full-page layout: a stepper under the header, no demo/simulation wording in the page copy.
    expect(replayHtml).toContain("run-stepper");
    expect(replayHtml).not.toMatch(/simulat|ui-band-sky/i);
    const liveHtml = render(new LiveSource({ base: "http://127.0.0.1:1", fetchImpl: diskFetch() }));
    expect(liveHtml).toContain("Start Run");
    expect(liveHtml).toContain("Queue run (guarded)");
  });
});

describe("exports for the landing", () => {
  it("TranscriptRows renders code-built rows read-only", () => {
    const l = get("demo-change-api-run-guarded");
    const rows = rowsOf(l).slice(0, 4);
    const html = renderToStaticMarkup(createElement(TranscriptRows, { rows }) as ReactElement);
    for (const r of rows) expect(html).toContain(r.title.replace(/&/g, "&amp;"));
    expect(html).not.toContain("<button");
    const one = renderToStaticMarkup(createElement(TranscriptRow, { row: rows[1]!, onToggle: () => {} }));
    expect(one).toContain('aria-expanded="false"');
  });
});

describe("transcript event rail (Hook Sidebar)", () => {
  it("money actions come from the recorded decision event: action, amount from minor units, status", () => {
    for (const l of loaded.values())
      for (const r of rowsOf(l)) {
        const m = moneyOf(r);
        const data = r.event?.data ?? {};
        if (r.type !== "decision" || typeof data.action !== "string" || data.action === "none") {
          expect(m).toBeNull();
          continue;
        }
        expect(m!.action).toBe(data.action);
        expect(m!.status).toBe(data.status);
        expect(m!.amountText).toBe(typeof data.amount === "number" ? moneyText(data.amount, data.currency as string | undefined) : undefined);
      }
  });

  it("filter counts are counts of rows, and every group keeps recorded order within its stage", () => {
    for (const l of loaded.values()) {
      const rows = rowsOf(l);
      const counts = filterCounts(rows);
      expect(counts.all).toBe(rows.length);
      for (const f of ["money", "held", "issues"] as const) expect(counts[f]).toBe(rows.filter((r) => matchesFilter(r, f)).length);
      const groups = transcriptGroups(rows, { view: "stage" });
      expect(groups.map((g) => g.stage)).toEqual(STAGES.filter((s) => rows.some((r) => r.stage === s)));
      expect(groups.flatMap((g) => g.rows).length).toBe(rows.length);
      for (const g of groups) {
        expect(g.rows.every((r) => r.stage === g.stage)).toBe(true);
        expect(g.rows.map((r) => rows.indexOf(r))).toEqual([...g.rows.map((r) => rows.indexOf(r))].sort((a, b) => a - b));
      }
      const order = transcriptGroups(rows, { view: "order" });
      expect(order.length).toBe(1);
      expect(order[0]!.rows).toEqual(rows);
      const held = transcriptGroups(rows, { view: "stage", filter: "held" }).flatMap((g) => g.rows);
      expect(held.length).toBe(counts.held);
    }
    expect(parseView("order")).toBe("order");
    expect(parseView(null)).toBe("stage");
    expect(clockTime("2026-10-10T08:46:38.139Z")).toBe("08:46:38.139");
  });

  it("renders one rail item per row with the recorded time, the amount, and a visible Rare UI credit", () => {
    const l = get("demo-run-guarded");
    const rows = rowsOf(l);
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(TranscriptTimeline, {
          rows,
          streaming: false,
          view: "stage",
          onViewChange: () => {},
          emptyText: "none",
          renderDetails: () => null,
        }),
      ),
    );
    expect((html.match(/data-slot="hook-sidebar-item"/g) ?? []).length).toBe(rows.length);
    for (const r of rows) {
      expect(html).toContain(r.title.replace(/&/g, "&amp;"));
      expect(html.toLowerCase()).toContain(`datetime="${r.at.toLowerCase()}"`);
    }
    for (const r of rows) {
      const m = moneyOf(r);
      if (m?.amountText) expect(html).toContain(m.amountText);
    }
    expect(html).toContain('href="https://rareui.com"');
    // With no selection and no stream, the newest event is selected and its panel shown.
    const latest = rows.at(-1)!;
    expect(html).toContain('aria-current="true"');
    expect(html).toContain(`${latest.title.replace(/&/g, "&amp;")}</h3>`);
    // A deep link (?decision=) selects its row instead of the newest one.
    const target = rows.find((r) => r.type === "decision" && r !== latest && r.held)!;
    const linked = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(TranscriptTimeline, {
          rows,
          streaming: false,
          view: "stage",
          onViewChange: () => {},
          targetKey: target.key,
          emptyText: "none",
          renderDetails: () => null,
        }),
      ),
    );
    expect(linked).toContain(`${target.title.replace(/&/g, "&amp;")}</h3>`);
    expect(linked).not.toContain(`${latest.title.replace(/&/g, "&amp;")}</h3>`);
  });
});
