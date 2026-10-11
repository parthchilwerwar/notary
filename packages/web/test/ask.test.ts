import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { BundleIndexSchema } from "../../core/src/schema/bundle";
import { AskResponseSchema, type ExplainAnswer, type RunBundle } from "../../core/src/schema";
import { validateBundle } from "../src/data";
import { matchAppRoute } from "../src/routes";
import {
  ASK_FAILED_TEXT,
  KIND_GROUPS,
  answerWorld,
  answersForRun,
  buildAskRequest,
  citationTarget,
  groupAnswers,
  groupCitations,
  parseAskResponse,
  parseExplainFile,
  worldIndex,
  worldKeyOf,
} from "../src/components/ask/model";
import { AnswerView, AskResultView } from "../src/components/ask/views";
import { isAskShortcut } from "../src/components/ask/AskContext";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8"));
const fixtureIndex = BundleIndexSchema.parse(read("bundles/fixture/index.json"));
const primaryIndex = BundleIndexSchema.parse(read("bundles/index.json"));
const bundles: RunBundle[] = [
  ...fixtureIndex.map((e) => validateBundle(read(`bundles/fixture/${e.runId}.json`), e)),
  ...primaryIndex.map((e) => validateBundle(read(`bundles/${e.runId}.json`), e)),
];
const explain = parseExplainFile(read("content/explain.json"));
if (!explain.ok) throw new Error(explain.error);
const answers = explain.data;
const byId = (id: string) => bundles.find((b) => b.runId === id)!;
const realCopy = (b: RunBundle, runId: string): RunBundle => ({ ...b, runId, sample: false });

/** Text content of static markup (tags stripped, entities decoded). */
const text = (el: ReactElement) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, el))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

describe("Ask Notary worlds", () => {
  it("keys every published bundle like core's worldKeyOf", () => {
    const keys = Object.fromEntries(bundles.map((b) => [b.runId, worldKeyOf(b)]));
    expect(keys["demo-run-guarded"]).toBe("fixture:default");
    expect(keys["demo-notarize-dodo"]).toBe("fixture:default");
    expect(keys["demo-change-api-run-guarded"]).toBe("fixture:change-api");
    expect(keys["demo-change-api-notarize-crustdata"]).toBe("fixture:change-api");
    expect(keys["sample-42"]).toBe("synthetic");
    expect(worldKeyOf(realCopy(byId("demo-run-guarded"), "real-run"))).toBe("real");
  });

  it("places every published answer in exactly one world", () => {
    const worlds = worldIndex(bundles);
    for (const a of answers) expect(answerWorld(a, worlds), a.id).toMatch(/^fixture:(default|change-api)$/);
  });

  it("never mixes fixture scenarios", () => {
    const worlds = worldIndex(bundles);
    const def = answersForRun(answers, bundles, "demo-run-guarded");
    const chg = answersForRun(answers, bundles, "demo-change-api-run-guarded");
    expect(def.world).toBe("fixture:default");
    expect(chg.world).toBe("fixture:change-api");
    expect(def.answers.length).toBeGreaterThan(0);
    expect(chg.answers.length).toBeGreaterThan(0);
    for (const a of def.answers) {
      expect(answerWorld(a, worlds)).toBe("fixture:default");
      expect(a.runIds.some((id) => id.startsWith("demo-change-api-"))).toBe(false);
      for (const c of a.citations) expect(c.runId?.startsWith("demo-change-api-") ?? false).toBe(false);
    }
    for (const a of chg.answers) {
      expect(answerWorld(a, worlds)).toBe("fixture:change-api");
      expect(a.runIds.every((id) => id.startsWith("demo-change-api-"))).toBe(true);
    }
    // Together they are every published answer, with no overlap.
    expect(def.answers.length + chg.answers.length).toBe(answers.length);
    expect(new Set([...def.answers, ...chg.answers].map((a) => a.id)).size).toBe(answers.length);
    // Any run of a scenario selects the same world; answers naming the selected run come first.
    const notarize = answersForRun(answers, bundles, "demo-notarize-dodo");
    expect(new Set(notarize.answers.map((a) => a.id))).toEqual(new Set(def.answers.map((a) => a.id)));
    const firstOther = notarize.answers.findIndex((a) => !a.runIds.includes("demo-notarize-dodo"));
    expect(notarize.answers.slice(firstOther).every((a) => !a.runIds.includes("demo-notarize-dodo"))).toBe(true);
  });

  it("shows no fixture answers for synthetic or real runs", () => {
    expect(answersForRun(answers, bundles, "sample-42")).toEqual({ world: "synthetic", answers: [] });
    const real = realCopy(byId("demo-run-guarded"), "real-guarded");
    expect(answersForRun(answers, [...bundles, real], "real-guarded")).toEqual({ world: "real", answers: [] });
    expect(answersForRun(answers, bundles, "not-a-run").answers).toEqual([]);
  });

  it("drops answers whose world can't be proven", () => {
    const worlds = worldIndex(bundles);
    const base = answers[0]!;
    expect(answerWorld({ ...base, runIds: ["demo-run-guarded", "demo-change-api-run-guarded"] }, worlds)).toBeUndefined();
    expect(answerWorld({ ...base, runIds: ["demo-run-guarded", "unknown-run"] }, worlds)).toBeUndefined();
    expect(answerWorld({ ...base, runIds: [] }, worlds)).toBeUndefined();
    expect(answerWorld({ ...base, runIds: ["demo-run-guarded"], sample: false }, worlds)).toBeUndefined();
  });
});

describe("Ask Notary grouping", () => {
  it("groups by kind in a fixed order, without empty groups", () => {
    for (const run of ["demo-run-guarded", "demo-change-api-run-guarded"]) {
      const scoped = answersForRun(answers, bundles, run).answers;
      const groups = groupAnswers(scoped);
      expect(groups.map((g) => g.kind)).toEqual(KIND_GROUPS.map((g) => g.kind).filter((k) => scoped.some((a) => a.kind === k)));
      expect(groups.map((g) => g.title)).toEqual(["Why held", "Tool knowledge", "What changed", "Revocations"]);
      expect(groups.reduce((n, g) => n + g.answers.length, 0)).toBe(scoped.length);
    }
    expect(groupAnswers([])).toEqual([]);
  });
});

describe("Ask Notary citations", () => {
  it("maps every published citation to an existing page or to plain text", () => {
    let links = 0;
    for (const a of answers)
      for (const c of a.citations) {
        const t = citationTarget(c, { fallbackRunId: a.runIds[0] });
        expect(t.id).toBe(c.id);
        if (t.type === "text") continue;
        links++;
        const [path, query] = t.to.split("?");
        expect(matchAppRoute(path!), t.to).toBeDefined();
        expect(path).not.toMatch(/approvals/);
        expect(new URLSearchParams(query).get("run")).toBe(c.runId ?? a.runIds[0]);
      }
    expect(links).toBeGreaterThan(0);
  });

  it("links decisions, probes and beliefs only to records the cited run's bundle holds", () => {
    let checked = 0;
    for (const a of answers)
      for (const c of a.citations) {
        if (!c.runId || !["decision", "probe", "belief"].includes(c.kind)) continue;
        const b = byId(c.runId);
        expect(b, c.runId).toBeDefined();
        const ids =
          c.kind === "decision"
            ? b.decisions.map((d) => d.id)
            : c.kind === "probe"
              ? b.probes.map((p) => p.id)
              : [...b.beliefs.before, ...b.beliefs.after].map((x) => x.id);
        expect(ids, `${c.kind} ${c.id} in ${c.runId}`).toContain(c.id);
        checked++;
      }
    expect(checked).toBeGreaterThan(0);
  });

  it("links records to their own URLs and keeps the cited run", () => {
    const run = "demo-change-api-run-guarded";
    expect(citationTarget({ kind: "decision", id: `${run}:q02`, runId: run })).toMatchObject({
      type: "link",
      to: `/app/run?run=${run}&decision=${encodeURIComponent(`${run}:q02`)}`,
    });
    expect(citationTarget({ kind: "probe", id: "p1", runId: run })).toMatchObject({ to: `/app/run?run=${run}&probe=p1` });
    expect(citationTarget({ kind: "belief", id: "belief-x", runId: run })).toMatchObject({ to: `/app/certificates?run=${run}&belief=belief-x` });
    expect(citationTarget({ kind: "belief_event", id: "belief-x#2", runId: run })).toMatchObject({ to: `/app/certificates?run=${run}&belief=belief-x` });
    expect(citationTarget({ kind: "certificate", id: "cert-1", runId: run })).toMatchObject({ to: `/app/certificates/cert-1?run=${run}` });
    expect(citationTarget({ kind: "claim", id: "dodo.refund.amount-minor-units", runId: run })).toMatchObject({ to: `/app/certificates?run=${run}&tool=dodo` });
    expect(citationTarget({ kind: "guard", id: "grd-1", runId: run })).toMatchObject({ to: `/app/run?run=${run}` });
    expect(citationTarget({ kind: "timeline_event", id: `${run}#4` })).toMatchObject({ to: `/app/run?run=${run}` });
    expect(citationTarget({ kind: "probe", id: "p1" }, { fallbackRunId: "demo-run-guarded" })).toMatchObject({ to: "/app/run?run=demo-run-guarded&probe=p1" });
  });

  it("sends revocations to their certificate when known, else the certificates list", () => {
    const c = { kind: "revocation" as const, id: "rev-6e9e0b74336c3b02", runId: "demo-change-api-run-guarded" };
    const certs = read("certificates/fixture/change-api/dodo.json") as { revocations: { id: string; certificateId: string }[] };
    const lookup = (id: string) => certs.revocations.find((r) => r.id === id)?.certificateId;
    expect(citationTarget(c, { revocationCertificate: lookup })).toMatchObject({
      type: "link",
      to: `/app/certificates/${lookup(c.id)}?run=demo-change-api-run-guarded`,
    });
    expect(citationTarget(c)).toMatchObject({ type: "link", to: "/app/certificates?run=demo-change-api-run-guarded" });
  });

  it("renders approvals, unknown kinds and malformed ids as plain text", () => {
    expect(citationTarget({ kind: "approval", id: "appr-1", runId: "r" })).toMatchObject({ type: "text", id: "appr-1" });
    expect(citationTarget({ kind: "mystery" as never, id: "m-1", runId: "r" })).toMatchObject({ type: "text", id: "m-1" });
    expect(citationTarget({ kind: "claim", id: "stripe.something", runId: "r" })).toMatchObject({ type: "text" });
    expect(citationTarget({ kind: "belief_event", id: "no-index", runId: "r" })).toMatchObject({ type: "text" });
    const markup = html(
      createElement(AskResultView, {
        response: { ok: true, answer: "Held.", citations: [{ kind: "approval", id: "appr-1" }, { kind: "decision", id: "d1", runId: "r" }] },
        ctx: {},
      }),
    );
    expect(markup).toContain("appr-1");
    expect(markup).not.toMatch(/href="[^"]*appr-1/);
    expect(markup).toContain('href="/app/run?run=r&amp;decision=d1"');
  });

  it("deduplicates citations by kind, id and run", () => {
    const groups = groupCitations([
      { kind: "guard", id: "g", runId: "r" },
      { kind: "guard", id: "g", runId: "r" },
      { kind: "belief", id: "b", runId: "r" },
      { kind: "guard", id: "g", runId: "s" },
    ]);
    expect(groups.map((g) => [g.kind, g.citations.length])).toEqual([
      ["guard", 2],
      ["belief", 1],
    ]);
  });
});

describe("Ask Notary responses", () => {
  it("accepts schema-valid answers and failures", () => {
    expect(parseAskResponse({ ok: true, answer: "A.", citations: [{ kind: "decision", id: "d" }] }).ok).toBe(true);
    expect(parseAskResponse({ ok: false, answer: ASK_FAILED_TEXT, reason: "BLOCKED: NOTARY_MODEL_EXECUTOR not set" }).ok).toBe(true);
    // Our constant is the schema's literal.
    expect(AskResponseSchema.safeParse({ ok: false, answer: ASK_FAILED_TEXT, reason: "x" }).success).toBe(true);
  });

  it("rejects schema-invalid responses", () => {
    for (const raw of [
      { ok: true, answer: "Uncited.", citations: [] },
      { ok: true, answer: "Bad kind.", citations: [{ kind: "approve_now", id: "x" }] },
      { ok: false, answer: "Sorry, I could not answer.", reason: "x" },
      { ok: false, answer: ASK_FAILED_TEXT },
      { answer: "no ok flag", citations: [{ kind: "decision", id: "d" }] },
      "<html>proxy error</html>",
      null,
    ]) {
      const parsed = parseAskResponse(raw);
      expect(parsed.ok, JSON.stringify(raw)).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/does not match the shared schema/);
    }
  });

  it("renders the failure text and the server's reason verbatim", () => {
    const reason = "BLOCKED: NOTARY_MODEL_EXECUTOR not set";
    const parsed = parseAskResponse({ ok: false, answer: ASK_FAILED_TEXT, reason });
    if (!parsed.ok) throw new Error(parsed.error);
    const out = text(createElement(AskResultView, { response: parsed.data, ctx: {} }));
    expect(out).toContain("couldn't answer from the evidence");
    expect(out).toContain(reason);
  });

  it("builds requests within the shared schema", () => {
    expect(buildAskRequest("  Why was q02 held?  ", "demo-run-guarded")).toEqual({
      ok: true,
      data: { question: "Why was q02 held?", runId: "demo-run-guarded" },
    });
    expect(buildAskRequest("   ", "r").ok).toBe(false);
    expect(buildAskRequest("x".repeat(2001), "r").ok).toBe(false);
  });
});

describe("Ask Notary is read-only", () => {
  it("renders every precomputed answer without action controls or approval links", () => {
    const certs = read("certificates/fixture/change-api/dodo.json") as { revocations: { id: string; certificateId: string }[] };
    for (const a of answers as ExplainAnswer[]) {
      const markup = html(
        createElement(AnswerView, {
          answer: a,
          ctx: { fallbackRunId: a.runIds[0], revocationCertificate: (id) => certs.revocations.find((r) => r.id === id)?.certificateId },
        }),
      );
      expect(markup).not.toContain("<button");
      expect(markup).not.toContain("<form");
      expect(markup).not.toMatch(/href="[^"]*approvals/);
      expect(text(createElement(AnswerView, { answer: a, ctx: {} }))).toContain(a.answer.slice(0, 80).replace(/\s+/g, " "));
    }
  });

  it("toggles on Ctrl+J / Cmd+J only", () => {
    const k = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(isAskShortcut(k("j", { ctrlKey: true }))).toBe(true);
    expect(isAskShortcut(k("J", { metaKey: true }))).toBe(true);
    expect(isAskShortcut(k("k", { ctrlKey: true }))).toBe(false);
    expect(isAskShortcut(k("j"))).toBe(false);
    expect(isAskShortcut(k("j", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
