import { existsSync, readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { RequestTypeSchema, type CertificateReport, type FixtureIndex, type ToolCertificates } from "../../core/src/schema";
import { finishedEntries, PublishedFiles, ReplaySource, validateBundle, type CertificateWorld } from "../src/data";
import {
  BANNED_RE,
  BUILT_WITH,
  EVALUATION_URL,
  FOOTER_LINKS,
  GITHUB_URL,
  REFUND_TYPES,
  actionsByType,
  certifyView,
  challengeView,
  chatQuestions,
  clipText,
  fixturePair,
  landingResults,
  money,
  navLinks,
  predictView,
  pricingPlans,
  proofNumbers,
  proofPair,
  revocationScenario,
  seeItWorkHref,
  showable,
  shortIds,
} from "../src/landing-data";
import { BAYER8, ditherOn, paintRect } from "../src/components/brand/dither";
import { foldChat, presentable } from "../src/components/landing/chat-turn";

const publicFile = (path: string) => JSON.parse(readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8"));
const fixtureFile = (name: string) => publicFile(`bundles/fixture/${name}`);
const read = (id: string) => validateBundle(fixtureFile(`${id}.json`));
const index = () => fixtureFile("index.json") as { runId: string; kind: string; variant: string; sample: boolean; startedAt: string }[];

const naive = read("demo-run-naive");
const guarded = read("demo-run-guarded");
const notarizeDodo = read("demo-notarize-dodo");
const notarizeCrust = read("demo-notarize-crustdata");

function world(dir: string): CertificateWorld {
  const report = publicFile(`certificates/fixture/${dir}/report.json`) as CertificateReport;
  const tools = report.tools.map((t) => publicFile(`certificates/fixture/${dir}/${t.file}`) as ToolCertificates);
  return { world: `fixture:${dir}`, sample: true, tools, report };
}

/** PublishedFiles over the files in public/ (no network). */
const files = () =>
  new PublishedFiles({
    base: "/",
    fetchImpl: (async (url: string) => {
      const p = new URL(`../public/${decodeURIComponent(String(url).replace(/^\//, ""))}`, import.meta.url);
      return existsSync(p)
        ? new Response(readFileSync(p), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch,
  });

describe("landing: which pair the Proof section shows", () => {
  it("uses the newest pair of one world when no real bundle exists", () => {
    const result = landingResults(index());
    expect(result.sample).toBe(true);
    expect(result.guarded?.runId).toBe("demo-run-guarded");
    expect(result.naive?.runId).toBe("demo-run-naive");
  });
  it("prefers real runs and never fills a missing real side with a simulated run", () => {
    const live = { ...guarded, sample: false, runId: "live-guarded" };
    const result = landingResults([naive, guarded, live]);
    expect(result.sample).toBe(false);
    expect(result.guarded).toBe(live);
    expect(result.naive).toBeUndefined();
  });
  it("falls back to the evaluation-suite pair, with the reason, when the real pair is incomplete", () => {
    const live = { ...guarded, sample: false, runId: "live-guarded" };
    const pair = proofPair([naive, guarded, live]);
    expect(pair.guarded).toBe(guarded);
    expect(pair.naive).toBe(naive);
    expect(pair.note).toMatch(/evaluation suite/);
    expect(showable(pair.note!)).toBe(true);
  });
  it("never pairs runs of two different worlds", () => {
    const result = fixturePair(index().filter((e) => e.runId !== "demo-run-naive"));
    expect(result.guarded?.runId).toBe("demo-run-guarded");
    expect(result.naive).toBeUndefined();
  });
});

describe("landing: every number comes from the bundles", () => {
  it("reads unsafe totals from grader metrics and counts held refunds from decisions", () => {
    const n = proofNumbers(naive, guarded);
    expect(n.naiveUnsafe).toBe(naive.metrics.unsafe_actions_total);
    expect(n.guardedUnsafe).toBe(guarded.metrics.unsafe_actions_total);
    expect(n.refundsHeld).toBe(guarded.decisions.filter((d) => d.status === "held" && d.requestType.includes("refund")).length);
    expect(n.requests).toBe(guarded.metrics.items_total);
  });
  it("reports a missing metric as null instead of zero", () => {
    const { unsafe_actions_total: _drop, ...metrics } = naive.metrics;
    expect(proofNumbers({ ...naive, metrics }, guarded).naiveUnsafe).toBeNull();
  });
  it("charts money actions per request type: allowed, unsafe and held, straight from decisions", () => {
    const rows = actionsByType(naive, guarded);
    expect(rows.map((r) => r.type)).toEqual(RequestTypeSchema.options);
    for (const r of rows) {
      const ds = (b: typeof naive) => b.decisions.filter((d) => d.requestType === r.type && d.action !== "none");
      expect(r.naive.executed).toBe(ds(naive).filter((d) => d.status === "executed").length);
      expect(r.guarded.held).toBe(ds(guarded).filter((d) => d.status === "held").length);
      expect(r.naive.unsafe).toBeLessThanOrEqual(r.naive.executed);
    }
    // The chart's unsafe columns add up to the grader's total.
    expect(rows.reduce((n, r) => n + r.naive.unsafe, 0)).toBe(naive.metrics.unsafe_actions_total);
  });
  it("derives refund types from the schema and formats money with the record's currency", () => {
    expect([...REFUND_TYPES].sort()).toEqual(RequestTypeSchema.options.filter((t) => t.includes("refund")).sort());
    expect(money(1999, "USD")).toBe("$19.99");
  });
});

describe("landing: How it works shows real records", () => {
  it("Predict, then test: a committed 'docs hold' prediction the observation contradicted", () => {
    const v = predictView(notarizeDodo)!;
    const probe = notarizeDodo.probes.find((p) => shortIds(p.id) === v.probe)!;
    expect(v.committedAt).toBe(probe.committedAt);
    expect(probe.verdict).toBe("confirmed");
    const mismatch = v.observed.find((f) => f.mismatch)!;
    expect(mismatch.key).toBe("outcome");
    expect(mismatch.value).toBe(String((probe.observed as { outcome: string }).outcome).replaceAll("_", " "));
    expect(mismatch.value).not.toBe(v.expected);
  });
  it("Challenge: a reviewed certificate, its Reflector hypothesis (never a code-built rival) and the review count", () => {
    const v = challengeView(world("default"), [notarizeDodo, notarizeCrust])!;
    const cert = world("default").tools.flatMap((t) => t.certificates).find((c) => c.claimId === v.claimId)!;
    expect(v.verdict).toBe(cert.adversary!.verdict);
    expect(v.counter).toBe(shortIds(cert.adversary!.reason));
    if (v.hypothesis) expect(v.hypothesis).not.toMatch(/not model-proposed|^verification rival/i);
    expect(v.survived).toBeLessThanOrEqual(v.challenges);
  });
  it("Certify & enforce: the certificate's serial and two real decisions (allowed, then held)", () => {
    const v = certifyView(world("default"), guarded)!;
    expect(v.certificateId).toMatch(/^cert-[0-9a-f]{16}$/);
    expect(v.rows.map((r) => r.outcome)).toEqual(["allowed", "held"]);
    for (const r of v.rows) {
      const d = guarded.decisions.find((x) => r.title.endsWith(` ${x.requestId}`) && x.action === r.action)!;
      expect(d.status).toBe(r.outcome === "allowed" ? "executed" : "held");
    }
  });
  it("Revocation card: the scenario whose export records a revocation", () => {
    const idx = publicFile("certificates/fixture/index.json") as FixtureIndex;
    const pick = revocationScenario(idx)!;
    expect(idx.scenarios.find((s) => s.scenario === pick.scenario)!.overall.revoked).toBeGreaterThan(0);
    expect(revocationScenario(null)).toBeUndefined();
  });
});

describe("landing: pricing only from the cfo.ai plan", () => {
  it("is hidden when economics.json is missing", () => {
    expect(existsSync(new URL("../public/economics.json", import.meta.url))).toBe(false);
    expect(pricingPlans(undefined)).toBeNull();
  });
  it("is hidden when the plan lacks prices or does not list three plans", () => {
    expect(pricingPlans({ pricing: { plans: [{ name: "A", period: "month" }, { name: "B", period: "month" }, { name: "C", period: "month" }] } })).toBeNull();
    expect(pricingPlans({ pricing: { plans: [{ name: "A", price: 1, period: "month" }] } })).toBeNull();
    expect(pricingPlans({ runway: 12 })).toBeNull();
  });
  it("shows three priced plans as published", () => {
    const plans = [1, 2, 3].map((n) => ({ name: `Plan ${n}`, price: n * 10, period: "month" }));
    expect(pricingPlans({ pricing: { plans } })).toEqual(plans);
  });
  it("hides the nav link with the section", () => {
    expect(navLinks(false).some((l) => l.label === "Pricing")).toBe(false);
    expect(navLinks(true).some((l) => l.label === "Pricing")).toBe(true);
    expect(readFileSync(new URL("../src/components/landing/Below.tsx", import.meta.url), "utf8")).toMatch(/\{plans && <Pricing plans=\{plans\} \/>\}/);
  });
});

describe("landing: See it work", () => {
  it("links to the video only when VITE_NOTARY_VIDEO_URL is an http(s) URL, else How it works", () => {
    expect(seeItWorkHref(undefined)).toEqual({ href: "#how", external: false });
    expect(seeItWorkHref("javascript:alert(1)")).toEqual({ href: "#how", external: false });
    expect(seeItWorkHref("https://example.com/v")).toEqual({ href: "https://example.com/v", external: true });
  });
});

describe("landing: the chat turn comes from the engine and passes the copy rules", () => {
  it("builds questions from the runs and keeps only presentable steps and lines", async () => {
    expect(chatQuestions(guarded, ["dodo"])[0]).toContain(guarded.decisions.find((d) => d.status === "held" && d.requestType.includes("refund"))!.requestId);
    const replay = new ReplaySource({ published: files() });
    const entries = finishedEntries(await replay.listRuns());
    expect(entries.length).toBeGreaterThan(0);
    const chat = replay.chat;
    chat.setContext?.({ runId: guarded.runId });
    let turn: ReturnType<typeof presentable> | undefined;
    for (const q of chatQuestions(guarded, ["dodo", "crustdata"])) {
      const c = await chat.createConversation();
      const events: Parameters<Parameters<typeof chat.sendMessage>[2]>[0][] = [];
      await chat.sendMessage(c.id, q, (e) => events.push(e));
      const t = presentable({ question: q, runId: guarded.runId, sample: true, ...foldChat(events) });
      if (t.steps.length >= 2 && t.paragraphs.length) {
        turn = t;
        break;
      }
    }
    expect(turn).toBeDefined();
    const text = [turn!.question, ...turn!.steps.flatMap((s) => [s.title, s.output ?? ""]), ...turn!.paragraphs, ...turn!.citations.map((c) => c.label)].join("\n");
    expect(text).not.toMatch(BANNED_RE);
  }, 30000);
});

describe("landing: dither renderer (Bayer 8×8)", () => {
  it("uses each threshold 0–63 exactly once", () => {
    expect(BAYER8.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });
  it("fills a cell when intensity > (bayer + 0.5) / 64", () => {
    expect(ditherOn(0, 0, 0.5 / 64 + 1e-9)).toBe(true);
    expect(ditherOn(0, 0, 0.5 / 64)).toBe(false);
    expect(ditherOn(7, 3, (22 + 0.5) / 64 + 1e-9)).toBe(true);
    let on = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) on += ditherOn(x, y, 0.5) ? 1 : 0;
    expect(on).toBe(32);
  });
  it("paints on whole device pixels: full at intensity 1, nothing at 0, and respects the reveal line", () => {
    const calls: number[][] = [];
    const ctx = { fillStyle: "", fillRect: (...a: number[]) => calls.push(a) } as unknown as CanvasRenderingContext2D;
    paintRect(ctx, { x: 0, y: 0, w: 24, h: 24 }, { kind: "dither", color: "red", base: 1, top: 1 }, { dpr: 2, cell: 3 });
    expect(calls.length).toBe(64);
    expect(calls.every((c) => c.every(Number.isInteger))).toBe(true);
    calls.length = 0;
    paintRect(ctx, { x: 0, y: 0, w: 24, h: 24 }, { kind: "dither", color: "red", base: 0, top: 0 }, { dpr: 2, cell: 3 });
    expect(calls.length).toBe(0);
    paintRect(ctx, { x: 0, y: 0, w: 24, h: 24 }, { kind: "solid", color: "blue" }, { dpr: 1, revealFromY: 12 });
    expect(calls).toEqual([[0, 12, 24, 12]]);
  });
});

// ------------------------------------------------------------------------------------- copy

const LANDING_FILES = [
  "Landing.tsx",
  "landing-data.ts",
  ...readdirSync(new URL("../src/components/landing/", import.meta.url)).map((f) => `components/landing/${f}`),
];
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

/**
 * Every string a visitor could read in the landing's source: JSX text and string/template literals,
 * minus module specifiers, the banned-word list itself and the data layer's `mode: "replay"` API
 * value (code, never shown).
 */
function visibleStrings(file: string): string[] {
  const sf = ts.createSourceFile(file, src(file), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^BANNED_/.test(n.name.text)) return;
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "mode") return;
    if (ts.isJsxText(n) && n.text.trim()) out.push(n.text.trim());
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    if (ts.isTemplateExpression(n)) out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("landing: product-site copy (no demo-style words)", () => {
  const strings = LANDING_FILES.flatMap((f) => visibleStrings(f).map((s) => ({ f, s })));
  const ALLOWED = ["Built for neatHack 2026", EVALUATION_URL];

  it("has no banned word in any visible string (only the footer line and the evaluation link are allowed)", () => {
    const hits = strings.filter(({ s }) => BANNED_RE.test(s) && !ALLOWED.includes(s));
    expect(hits).toEqual([]);
  });
  it("keeps the footer line and the single stats footnote", () => {
    expect(src("components/landing/Footer.tsx")).toContain("Built for neatHack 2026");
    expect(src("components/landing/Proof.tsx")).toMatch(/Measured on Notary’s evaluation suite/);
    expect(EVALUATION_URL).toBe(`${GITHUB_URL}/blob/main/docs/EVALUATION.md#evaluation-suite`);
  });
  it("says See it work, never Watch the demo", () => {
    const all = LANDING_FILES.map(src).join("\n");
    expect(all).toContain("See it work");
    expect(all).not.toMatch(/watch the demo/i);
  });
  it("filters data-derived text with the same rule", () => {
    expect(showable("Refund q01 held — no certificate for dodo.payments.page-size-max-100")).toBe(true);
    expect(showable("Reading the decision for q01 of demo-run-guarded")).toBe(false);
    expect(showable("fixture scenario default (simulated APIs)")).toBe(false);
    expect(shortIds("cited probes (demo-notarize-dodo-p017, demo-notarize-dodo-p018)")).toBe("cited probes (p017, p018)");
    expect(clipText("a b c d e f", 5)).toBe("a b…");
  });
  it("names the credits as text and links one GitHub constant", () => {
    expect(GITHUB_URL).toBe("https://github.com/parthchilwerwar/notary");
    expect(BUILT_WITH).toEqual(["neatlogs", "Entire", "cfo.ai", "Crustdata", "Dodo Payments", "AWS Bedrock"]);
    expect(FOOTER_LINKS.map((l) => l.label)).toEqual(["GitHub", "Dashboard", "Docs"]);
  });
  it("uses GSAP only (useGSAP, SplitText, ScrollTrigger, matchMedia for reduced motion)", () => {
    const all = LANDING_FILES.map(src).join("\n");
    expect(all).not.toMatch(/from "motion|@xyflow/);
    expect(all).toMatch(/SplitText\.create/);
    expect(all).toMatch(/scrollTrigger/);
    expect(all).toMatch(/gsap\.matchMedia\(\)/);
  });
});
