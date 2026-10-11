import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleIndexSchema } from "../../core/src/schema/bundle";
import type {
  ApprovalRecord,
  ApprovalsList,
  PendingApproval,
  RunBundle,
} from "../../core/src/schema";
import { validateBundle } from "../src/data";
import {
  amountMatches,
  approveGate,
  buildApproveRequest,
  buildDesk,
  buildRejectRequest,
  deskMode,
  heldDecisions,
  parseApprovalRecord,
  parseApprovalsList,
  rejectGate,
} from "../src/pages/approvals/model";
import { fetchApprovals, pendingId, submitDecision } from "../src/pages/approvals/api";
import { LiveSource, LocalApiError, ReplayOnlyError, ReplaySource, approvalId } from "../src/data";

// The page renders the decision trail; another module owns it, so render tests use a stand-in.
vi.mock("../src/components/trail", () => ({
  DecisionTrail: ({ decisionId }: { decisionId: string }) =>
    createElement("section", { "data-trail": decisionId }),
}));

const mockData = { current: {} as Record<string, unknown> };
vi.mock("../src/app/catalog", () => ({
  useData: () => mockData.current,
}));

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8"));
const fixtureIndex = BundleIndexSchema.parse(read("bundles/fixture/index.json"));
const guarded = validateBundle(
  read("bundles/fixture/demo-run-guarded.json"),
  fixtureIndex.find((e) => e.runId === "demo-run-guarded"),
);

/** A real-world copy of a fixture bundle (sample false), for desk merging only. */
function realCopy(bundle: RunBundle, runId: string): RunBundle {
  return {
    ...bundle,
    runId,
    sample: false,
    decisions: bundle.decisions.map((d) => ({ ...d })),
  };
}

const item = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  runId: "run-a",
  decisionId: "run-a:q01",
  requestId: "q01",
  action: "dodo.createRefund",
  amount: 4900,
  currency: "USD",
  reason: "missing belief",
  missingBeliefs: ["belief-x"],
  ...over,
});

const record = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: "appr-0123456789abcdef",
  runId: "run-a",
  decisionId: "run-a:q02",
  requestId: "q02",
  action: "dodo.createRefund",
  decision: "rejected",
  reason: "customer withdrew",
  humanOverride: true,
  effects: [],
  status: "closed",
  decidedAt: "2026-10-10T09:00:00.000Z",
  ...over,
});

describe("typed amount confirmation", () => {
  it("matches only the exact minor-unit digits", () => {
    expect(amountMatches("4900", 4900)).toBe(true);
    expect(amountMatches("  4900 ", 4900)).toBe(true);
    for (const typed of ["4,900", "4900.0", "04900", "49.00", "4901", "", "4900 USD", "-4900"])
      expect(amountMatches(typed, 4900)).toBe(false);
  });

  it("never matches an unknown held amount", () => {
    expect(amountMatches("", undefined)).toBe(false);
    expect(amountMatches("0", undefined)).toBe(false);
  });

  it("builds an approve request only when the typed amount equals the held amount", () => {
    expect(buildApproveRequest(item(), "4899").ok).toBe(false);
    expect(buildApproveRequest(item({ amount: undefined }), "4900").ok).toBe(false);
    const built = buildApproveRequest(item(), "4900");
    expect(built).toEqual({
      ok: true,
      request: {
        decision: "approved",
        runId: "run-a",
        decisionId: "run-a:q01",
        confirmedAmount: 4900,
      },
    });
  });
});

describe("rejection", () => {
  it("needs a non-empty reason", () => {
    expect(buildRejectRequest(item(), "").ok).toBe(false);
    expect(buildRejectRequest(item(), "   \n").ok).toBe(false);
    expect(buildRejectRequest(item(), "  duplicate ask ")).toEqual({
      ok: true,
      request: {
        decision: "rejected",
        runId: "run-a",
        decisionId: "run-a:q01",
        reason: "duplicate ask",
      },
    });
  });
});

describe("mode gating", () => {
  const real = { sample: false };
  const ok = { mode: "local" as const, testMode: true, token: "t", bundle: real };

  it("the desk is local only when a notary serve answered", () => {
    expect(deskMode("api")).toBe("local");
    expect(deskMode("static")).toBe("hosted");
  });

  it("allows both actions on a real run in local test mode with a token", () => {
    expect(approveGate(ok, item())).toEqual({ allowed: true });
    expect(rejectGate(ok)).toEqual({ allowed: true });
  });

  it("hosted mode exposes no actions", () => {
    const hosted = { ...ok, mode: "hosted" as const };
    expect(approveGate(hosted, item()).allowed).toBe(false);
    expect(rejectGate(hosted).allowed).toBe(false);
  });

  it("sample runs are never actionable", () => {
    const sample = { ...ok, bundle: { sample: true } };
    expect(approveGate(sample, item()).allowed).toBe(false);
    expect(rejectGate(sample).allowed).toBe(false);
    const unknown = { ...ok, bundle: undefined };
    expect(approveGate(unknown, item()).allowed).toBe(false);
    expect(rejectGate(unknown).allowed).toBe(false);
  });

  it("approve needs test mode and a computed amount; reject needs neither", () => {
    expect(approveGate({ ...ok, testMode: false }, item()).allowed).toBe(false);
    expect(approveGate({ ...ok, testMode: undefined }, item()).allowed).toBe(false);
    expect(rejectGate({ ...ok, testMode: false }).allowed).toBe(true);
    const noAmount = approveGate(ok, item({ amount: undefined }));
    expect(noAmount.allowed).toBe(false);
    if (!noAmount.allowed) expect(noAmount.reason).toMatch(/nothing to confirm against/);
  });

  it("no token, no action", () => {
    expect(approveGate({ ...ok, token: null }, item()).allowed).toBe(false);
    expect(rejectGate({ ...ok, token: null }).allowed).toBe(false);
  });
});

describe("desk merging", () => {
  const held = heldDecisions(guarded);

  it("hosted mode ignores any server list and shows the selected run's held items as history", () => {
    const list: ApprovalsList = {
      testMode: true,
      pending: [item({ runId: guarded.runId, decisionId: held[0]!.id })],
      decided: [record()],
    };
    const desk = buildDesk({ mode: "hosted", list, bundles: [guarded], selected: guarded });
    expect(desk.pending).toEqual([]);
    expect(desk.decided).toEqual([]);
    expect(desk.history.map((r) => r.decision.id)).toEqual(held.map((d) => d.id));
    expect(desk.history.every((r) => /Fixture data/.test(r.note))).toBe(true);
  });

  it("drops pending items from sample runs (never offered)", () => {
    const list: ApprovalsList = {
      testMode: true,
      pending: [item({ runId: guarded.runId, decisionId: held[0]!.id })],
      decided: [],
    };
    const desk = buildDesk({ mode: "local", list, bundles: [guarded], selected: guarded });
    expect(desk.pending).toEqual([]);
    expect(desk.droppedSample).toBe(1);
  });

  it("joins pending and decided items to their bundle and keeps them out of history", () => {
    const run = realCopy(guarded, "run-real");
    const runHeld = heldDecisions(run);
    expect(runHeld.length).toBeGreaterThan(1);
    const [first, second] = runHeld as [typeof runHeld[0], typeof runHeld[0]];
    const list: ApprovalsList = {
      testMode: true,
      pending: [item({ runId: run.runId, decisionId: first.id, requestId: first.requestId })],
      decided: [
        record({ runId: run.runId, decisionId: second.id, requestId: second.requestId, decidedAt: "2026-10-10T09:00:00.000Z" }),
        record({ id: "appr-ffffffffffffffff", runId: "other", decisionId: "other:q9", decidedAt: "2026-10-10T10:00:00.000Z" }),
      ],
    };
    const desk = buildDesk({ mode: "local", list, bundles: [run], selected: run });
    expect(desk.pending).toHaveLength(1);
    expect(desk.pending[0]!.decision?.id).toBe(first.id);
    expect(desk.pending[0]!.bundle?.runId).toBe(run.runId);
    // Newest decision first; unknown runs have no bundle.
    expect(desk.decided.map((r) => r.record.id)).toEqual([
      "appr-ffffffffffffffff",
      "appr-0123456789abcdef",
    ]);
    expect(desk.decided[0]!.bundle).toBeUndefined();
    expect(desk.decided[1]!.decision?.id).toBe(second.id);
    const historyIds = desk.history.map((r) => r.decision.id);
    expect(historyIds).not.toContain(first.id);
    expect(historyIds).not.toContain(second.id);
    expect(historyIds).toHaveLength(runHeld.length - 2);
  });
});

describe("server data validation", () => {
  it("accepts a valid list and rejects schema-invalid ones", () => {
    const valid = { testMode: false, pending: [item()], decided: [record()] };
    expect(parseApprovalsList(valid)).toEqual(valid);
    expect(() => parseApprovalsList({ pending: [], decided: [] })).toThrow(/shared schema/);
    expect(() =>
      parseApprovalsList({ testMode: true, pending: [{ ...item(), amount: 49.5 }], decided: [] }),
    ).toThrow(/shared schema/);
    expect(() =>
      parseApprovalsList({ testMode: true, pending: [], decided: [{ ...record(), humanOverride: false }] }),
    ).toThrow(/shared schema/);
  });

  it("rejects a schema-invalid approval record", () => {
    expect(parseApprovalRecord(record())).toEqual(record());
    expect(() => parseApprovalRecord({ ...record(), status: "done" })).toThrow(/shared schema/);
    expect(() => parseApprovalRecord({ ...record(), decidedAt: "yesterday" })).toThrow(/shared schema/);
  });
});

describe("local API calls through the data layer (mocked fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) =>
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  const live = (fetchImpl: typeof fetch, token: string | null = "tok") =>
    new LiveSource({ base: "http://localhost:8787", fetchImpl, token: () => token });

  it("rejects: POST /api/approvals/:id/reject with the bearer token, validated record back", async () => {
    const fetchMock = respond(200, record());
    const built = buildRejectRequest(item(), "customer withdrew");
    if (!built.ok) throw new Error(built.error);
    await expect(submitDecision(live(fetchMock), item(), built.request)).resolves.toEqual(record());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://localhost:8787/api/approvals/${approvalId("run-a", "run-a:q01")}/reject`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ reason: "customer withdrew" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("approves by the pending item's own id with the typed amount", async () => {
    const fetchMock = respond(200, record({ decision: "approved", confirmedAmount: 4900, status: "executed", reason: undefined }));
    const built = buildApproveRequest(item({ id: "appr-feedfeedfeedfeed" }), "4900");
    if (!built.ok) throw new Error(built.error);
    await submitDecision(live(fetchMock), item({ id: "appr-feedfeedfeedfeed" }), built.request);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/api/approvals/appr-feedfeedfeedfeed/approve");
    expect(JSON.parse(String(init.body))).toEqual({ confirmedAmount: 4900 });
    expect(pendingId(item())).toBe(approvalId("run-a", "run-a:q01"));
  });

  it("surfaces server errors verbatim", async () => {
    const built = buildApproveRequest(item(), "4900");
    if (!built.ok) throw new Error(built.error);
    const err = await submitDecision(
      live(respond(503, { error: "BLOCKED: DODO_PAYMENTS_API_KEY not set" })),
      item(),
      built.request,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalApiError);
    expect((err as LocalApiError).status).toBe(503);
    expect((err as LocalApiError).message).toBe("BLOCKED: DODO_PAYMENTS_API_KEY not set");
    await expect(
      submitDecision(live(respond(409, { error: "decision run-a:q01 was already rejected (closed)" })), item(), built.request),
    ).rejects.toThrow("decision run-a:q01 was already rejected (closed)");
  });

  it("rejects a 200 body that is not an approval record, and a schema-invalid list", async () => {
    const built = buildRejectRequest(item(), "no");
    if (!built.ok) throw new Error(built.error);
    await expect(submitDecision(live(respond(200, { ok: true })), item(), built.request)).rejects.toThrow(/shared schema/);
    await expect(
      fetchApprovals(live(respond(200, { testMode: "yes", pending: [], decided: [] }))),
    ).rejects.toThrow(/shared schema/);
  });

  it("never calls the server without a token", async () => {
    const fetchMock = respond(200, {});
    await expect(fetchApprovals(live(fetchMock, null))).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replay: decisions are refused with ReplayOnlyError, no request sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const built = buildRejectRequest(item(), "no");
    if (!built.ok) throw new Error(built.error);
    await expect(submitDecision(new ReplaySource(), item(), built.request)).rejects.toBeInstanceOf(ReplayOnlyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Renders full decision trails (hundreds of lines) in jsdom: CPU-bound, so allow for a busy machine.
describe("rendered desk", { timeout: 30_000 }, () => {
  async function renderPage(source: "api" | "static", bundle: RunBundle, others: RunBundle[] = []) {
    mockData.current = { source, bundles: [bundle, ...others], bundle, selectedRunId: bundle.runId };
    const { ApprovalsPage } = await import("../src/pages/approvals");
    return renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ApprovalsPage)),
    );
  }

  it("hosted: read-only history with evidence and trails, no Approve/Reject buttons", async () => {
    const notarize = validateBundle(
      read("bundles/fixture/demo-notarize-dodo.json"),
      fixtureIndex.find((e) => e.runId === "demo-notarize-dodo"),
    );
    const html = await renderPage("static", guarded, [notarize]);
    expect(html).toContain("Read-only history");
    // Related probes link to the run that recorded them.
    const probeId = heldDecisions(guarded)[0]!.evidencePack!.relatedProbeIds[0]!;
    expect(notarize.probes.some((p) => p.id === probeId)).toBe(true);
    expect(html).toContain(`href="/app/run?run=demo-notarize-dodo&amp;probe=${encodeURIComponent(probeId)}"`);
    expect(html).not.toMatch(/Approve…|Reject…|Approve and execute/);
    const held = heldDecisions(guarded);
    for (const d of held) expect(html).toContain(`data-trail="${d.id}"`);
    expect(html).toContain("Evidence pack");
    expect(html).toContain("Fixture data: recorded for review, never approvable.");
  });

  it("local without a token: asks for the session token and offers no actions yet", async () => {
    const html = await renderPage("api", realCopy(guarded, "run-real"));
    expect(html).toContain("Session token");
    expect(html).not.toMatch(/Approve…|Reject…/);
  });

  it("confirm dialog starts with the submit button disabled and is labelled", async () => {
    const { ConfirmDialog } = await import("../src/pages/approvals/ConfirmDialog");
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        source: new ReplaySource(),
        kind: "approve",
        item: item(),
        token: "tok",
        onClose: () => {},
        onDecided: () => {},
        onStale: () => {},
      }),
    );
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="[^"]+"/);
    expect(html).toContain("4,900 USD minor units");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
