/**
 * POST /api/ask: deterministic retrieval from one data world, model answers validated by code.
 * The model is a test double (no network); bundles are the synthetic sample bundle plus a copy of
 * it re-flagged as real (both test data, never a run result).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASK_FAILED_ANSWER, answerQuestion, parseModelAnswer, retrieve } from "../src/api/ask.js";
import { EventBus } from "../src/api/bus.js";
import type { LoadedBundle } from "../src/api/bundle-source.js";
import { timelineEventId } from "../src/explain/citations.js";
import { worldKeyOf } from "../src/explain/world.js";
import { ToolCertificatesSchema } from "../src/schema/certificate.js";
import type { Certificate, ToolCertificates } from "../src/schema/certificate.js";
import { appendTimelineEvents } from "../src/timeline/store.js";
import { createApp } from "../src/api/server.js";
import { createSession } from "../src/api/session.js";
import { buildSampleBundle, finalizeBundle, writeBundle } from "../src/bundle/index.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../src/llm/client.js";
import { AskResponseSchema } from "../src/schema/explain.js";
import type { RunBundle } from "../src/schema/index.js";
import { setSpanSink } from "../src/trace/index.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

let root: string;
let sampleDir: string;
let realDir: string;
let sample: RunBundle;
let real: RunBundle;

/** Model double: returns `reply` (or reply(request)) and remembers every request. */
function fakeLlm(reply: string | ((req: CompleteRequest) => string)): LlmLike & { calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = [];
  return {
    calls,
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      calls.push(req);
      return { text: typeof reply === "string" ? reply : reply(req), inputTokens: 1, outputTokens: 1, usd: 0, modelId: "test-double", stopReason: "end_turn" };
    },
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "notary-ask-"));
  sampleDir = join(root, "web");
  realDir = join(root, "runs", "real-run-1");
  sample = buildSampleBundle(42);
  // A copy flagged real (sample: false) under another run id: a second, separate data world.
  real = finalizeBundle({ ...sample, runId: "real-run-1", sample: false });
  await writeBundle(sample, sampleDir);
  await writeBundle(real, realDir);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const dirs = () => [sampleDir, realDir];
const L = (bundle: RunBundle, dir: string) => ({ bundle, dir });

describe("retrieval", () => {
  it("uses one data world: real when any real bundle exists, the named run's world otherwise", () => {
    const d = sample.decisions[0]!;
    const r = retrieve([L(sample, sampleDir), L(real, realDir)], { question: `why was ${d.requestId} ${d.status}?` });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.world).toBe("real");
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.records.every((x) => x.runId === "real-run-1")).toBe(true);

    const s = retrieve([L(sample, sampleDir), L(real, realDir)], { question: "why held?", runId: sample.runId });
    if ("error" in s) throw new Error(s.error);
    expect(s.world).toBe("synthetic");
    expect(s.records.every((x) => x.runId === sample.runId)).toBe(true);
    expect(s.index.find("decision", d.id, "real-run-1")).toEqual([]);
  });

  it("prefers a record whose id the question names, and is deterministic", () => {
    const d = sample.decisions[3]!;
    const q = { question: `explain decision ${d.id}`, runId: sample.runId };
    const a = retrieve([L(sample, sampleDir), L(real, realDir)], q);
    const b = retrieve([L(real, realDir), L(sample, sampleDir)], q);
    if ("error" in a || "error" in b) throw new Error("retrieval failed");
    expect(a.records[0]).toMatchObject({ kind: "decision", id: d.id });
    expect(a.records.map((x) => `${x.kind}:${x.id}`)).toEqual(b.records.map((x) => `${x.kind}:${x.id}`));
    expect(a.records.length).toBeLessThanOrEqual(12);
  });

  it("an unknown run or no bundles is an error, not a guess", () => {
    expect(retrieve([L(sample, sampleDir)], { question: "x", runId: "nope" })).toEqual({ error: "unknown run nope" });
    expect(retrieve([], { question: "x" })).toEqual({ error: "no bundles are loaded" });
  });
});

describe("answer validation", () => {
  it("parses strict JSON (one code fence tolerated) and rejects anything else", () => {
    expect(parseModelAnswer('{"answer":"a","citations":[]}')).toMatchObject({ ok: true });
    expect(parseModelAnswer('```json\n{"answer":"a","citations":[]}\n```')).toMatchObject({ ok: true });
    expect(parseModelAnswer("Sure! here it is")).toMatchObject({ ok: false });
    expect(parseModelAnswer('{"answer":"a","citations":[],"extra":1}')).toMatchObject({ ok: false });
    expect(parseModelAnswer('{"answer":"","citations":[]}')).toMatchObject({ ok: false });
  });

  it("ok:true only when every citation resolves to a loaded record", async () => {
    const d = real.decisions[0]!;
    const llm = fakeLlm(JSON.stringify({ answer: `It was ${d.status}.`, citations: [{ kind: "decision", id: d.id, runId: real.runId }] }));
    const res = AskResponseSchema.parse(await answerQuestion({ question: `why was ${d.requestId} ${d.status}?` }, { bundleDirs: dirs, llm }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.citations).toEqual([expect.objectContaining({ kind: "decision", id: d.id, runId: real.runId })]);
    expect(res.traceId).toMatch(/^[0-9a-f]{32}$/);
    // The model saw only retrieved records from the one world, with the strict-JSON instruction.
    expect(llm.calls[0]!.role).toBe("executor");
    expect(llm.calls[0]!.system).toMatch(/ONLY the records/);
    const shownRuns = new Set([...llm.calls[0]!.messages[0]!.content.matchAll(/ runId=(\S+)/g)].map((m) => m[1]));
    expect([...shownRuns]).toEqual([real.runId]);
  });

  it.each([
    ["not JSON", "I think it was held because of beliefs."],
    ["no citation", JSON.stringify({ answer: "held", citations: [] })],
    ["unknown record", JSON.stringify({ answer: "held", citations: [{ kind: "decision", id: "made-up", runId: "real-run-1" }] })],
    ["record from the other world", JSON.stringify({ answer: "held", citations: [{ kind: "decision", id: "x", runId: "sample-42" }] })],
    ["bad kind", JSON.stringify({ answer: "held", citations: [{ kind: "rumour", id: "x" }] })],
  ])("%s -> couldn't answer from the evidence", async (_label, reply) => {
    const d = real.decisions[0]!;
    const res = AskResponseSchema.parse(await answerQuestion({ question: `why was ${d.id} held?` }, { bundleDirs: dirs, llm: fakeLlm(reply) }));
    expect(res.ok).toBe(false);
    expect(res.answer).toBe(ASK_FAILED_ANSWER);
  });

  it("keyless: BLOCKED with no model call (no model id / region)", async () => {
    const res = await answerQuestion({ question: "why?" }, { bundleDirs: dirs, env: {} });
    expect(res).toMatchObject({ ok: false, answer: ASK_FAILED_ANSWER });
    if (res.ok) return;
    expect(res.reason).toBe("BLOCKED: NOTARY_MODEL_EXECUTOR not set — set it in .env (see .env.example) and run `pnpm notary doctor --llm`");
    const noRegion = await answerQuestion({ question: "why?" }, { bundleDirs: dirs, env: { NOTARY_MODEL_EXECUTOR: "some.model" } });
    expect(noRegion).toMatchObject({ ok: false, reason: "BLOCKED: AWS_REGION not set — set it in .env (see .env.example) and run `pnpm notary doctor --llm`" });
  });

  it("each ask is one span with question length, retrieved count and citation validity (never the question text)", async () => {
    const sink = join(root, "spans.jsonl");
    setSpanSink(sink);
    try {
      const d = real.decisions[0]!;
      const question = `zebra-marker why was ${d.id} ${d.status}?`;
      await answerQuestion({ question }, { bundleDirs: dirs, llm: fakeLlm(JSON.stringify({ answer: "x", citations: [{ kind: "decision", id: d.id, runId: real.runId }] })) });
    } finally {
      setSpanSink(null);
    }
    const text = readFileSync(sink, "utf8");
    const spans = text.trim().split("\n").map((l) => JSON.parse(l) as { name: string; attrs: Record<string, unknown> });
    const ask = spans.find((s) => s.name === "notary.ask")!;
    expect(ask.attrs["notary.ask.question_length"]).toBeGreaterThan(0);
    expect(ask.attrs["notary.ask.retrieved"]).toBeGreaterThan(0);
    expect(ask.attrs["notary.ask.citations_valid"]).toBe(true);
    expect(ask.attrs["notary.ask.world"]).toBe("real");
    expect(text).not.toContain("zebra-marker");
  });
});

describe("POST /api/ask over HTTP", () => {
  it("needs the token; keyless answers BLOCKED", async () => {
    const session = createSession();
    const app = createApp({ bundleDirs: [sampleDir], runsDir: join(root, "runs"), bus: new EventBus(), session, ask: { env: {} } });
    const call = (auth: boolean, body: unknown) =>
      app.request(
        "/api/ask",
        {
          method: "POST",
          headers: { Host: "127.0.0.1:8787", "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${session.token}` } : {}) },
          body: JSON.stringify(body),
        },
        LOOPBACK,
      );
    expect((await call(false, { question: "why?" })).status).toBe(401);
    expect((await call(true, { question: "" })).status).toBe(400);
    const res = await call(true, { question: "why was q01 held?" });
    expect(res.status).toBe(200);
    expect(AskResponseSchema.parse(await res.json())).toMatchObject({ ok: false, answer: ASK_FAILED_ANSWER, reason: expect.stringMatching(/^BLOCKED:/) });
  });
});

describe("read-only by construction", () => {
  // Every module src/api/ask.ts reaches, transitively.
  function importsOf(source: string): string[] {
    const specs: string[] = [];
    for (const m of source.matchAll(/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) specs.push((m[1] ?? m[2])!);
    return specs;
  }
  function graph(entry: string): string[] {
    const seen = new Set<string>();
    const stack = [resolve(SRC, entry)];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const s of importsOf(readFileSync(file, "utf8"))) if (s.startsWith(".")) stack.push(resolve(dirname(file), s.replace(/\.js$/, ".ts")));
    }
    return [...seen].map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/")).sort();
  }
  const FORBIDDEN = [/^tools\/(?!errors\.ts$)/, /^guards\//, /^queue\//, /^api\/approvals/, /^reflect\//, /^adversary\//, /^store\//];

  it("the detector sees the modules it should (no vacuous pass)", () => {
    const g = graph("api/ask.ts");
    expect(g).toEqual(expect.arrayContaining(["api/ask.ts", "explain/citations.ts", "llm/client.ts", "api/bundle-source.ts"]));
    expect(graph("api/approvals.ts").some((f) => FORBIDDEN.some((re) => re.test(f)))).toBe(true);
  });

  it("imports no tool client, guarded wrapper, queue executor, store or approval code, transitively", () => {
    const g = graph("api/ask.ts");
    expect(g).toEqual(expect.arrayContaining(["api/ask-world.ts", "explain/world.ts", "timeline/store.ts"]));
    const bad = g.filter((f) => FORBIDDEN.some((re) => re.test(f)));
    expect(bad).toEqual([]);
  });
});

describe("one world per ask: fixture scenarios, certificates, timelines, approvals", () => {
  // Two simulated fixture scenarios built from the synthetic sample (test data only).
  const fixture = (seed: number, runId: string, scenario?: string): RunBundle => {
    const b = buildSampleBundle(seed);
    return finalizeBundle({
      ...b,
      runId,
      kind: "run",
      variant: "guarded",
      sample: true,
      disclosure: [...b.disclosure, `FIXTURE${scenario ? ` (fixture scenario ${scenario})` : ""}: simulated APIs, test data`],
    });
  };
  // Certificate template: the first committed fixture certificate, re-pointed at a test bundle.
  const template = (): Certificate => {
    const file = JSON.parse(readFileSync(new URL("../../web/public/certificates/fixture/default/dodo.json", import.meta.url), "utf8")) as ToolCertificates;
    return file.certificates[0]!;
  };
  const certFor = (b: RunBundle, id: string): Certificate => ({ ...template(), id, sample: true, sourceBundle: { runId: b.runId, contentHash: b.contentHash } });
  const toolFile = (scenario: string, certs: Certificate[]): ToolCertificates =>
    ToolCertificatesSchema.parse({
      tool: "dodo",
      generatedBy: "test",
      sample: true,
      scenario,
      disclosure: ["test data"],
      header: "test",
      sourceBundles: [],
      ignoredBundles: [],
      certificates: certs,
      noCertificates: [],
      revocations: [],
    });

  let fxRoot: string;
  let certsDir: string;
  let fxDefault: RunBundle;
  let fxChange: RunBundle;
  let loaded: LoadedBundle[];
  const CERT_DEFAULT = "cert-00000000000000d1";
  const CERT_CHANGE = "cert-00000000000000c1";

  beforeAll(async () => {
    fxRoot = mkdtempSync(join(tmpdir(), "notary-ask-fx-"));
    certsDir = join(fxRoot, "certificates");
    fxDefault = fixture(5, "fx-default-run");
    fxChange = fixture(6, "fx-change-run", "change-api");
    await writeBundle(fxDefault, join(fxRoot, "runs", fxDefault.runId));
    await writeBundle(fxChange, join(fxRoot, "runs", fxChange.runId));
    const sets: Array<[string, RunBundle, string]> = [
      ["default", fxDefault, CERT_DEFAULT],
      ["change-api", fxChange, CERT_CHANGE],
    ];
    for (const [scenario, b, id] of sets) {
      mkdirSync(join(certsDir, "fixture", scenario), { recursive: true });
      writeFileSync(join(certsDir, "fixture", scenario, "dodo.json"), JSON.stringify(toolFile(scenario, [certFor(b, id)])));
    }
    loaded = [
      { bundle: fxDefault, dir: join(fxRoot, "runs", fxDefault.runId) },
      { bundle: fxChange, dir: join(fxRoot, "runs", fxChange.runId) },
    ];
  });
  afterAll(() => rmSync(fxRoot, { recursive: true, force: true }));

  it("worldKeyOf keys: the two fixture scenarios are separate worlds", () => {
    expect([fxDefault, fxChange, sample, real].map(worldKeyOf)).toEqual(["fixture:default", "fixture:change-api", "synthetic", "real"]);
  });

  it("never mixes fixture scenarios in one retrieval (records, index and certificates)", () => {
    const cases: Array<[RunBundle, RunBundle, string, string]> = [
      [fxDefault, fxChange, CERT_DEFAULT, CERT_CHANGE],
      [fxChange, fxDefault, CERT_CHANGE, CERT_DEFAULT],
    ];
    for (const [b, other, cert, otherCert] of cases) {
      const r = retrieve(loaded, { question: "which certificates were issued for dodo refunds?", runId: b.runId }, { certificatesDir: certsDir, runsDir: join(fxRoot, "runs") });
      if ("error" in r) throw new Error(r.error);
      expect(r.world).toBe(worldKeyOf(b));
      expect(r.bundles.map((x) => x.runId)).toEqual([b.runId]);
      expect(r.records.every((x) => x.runId === b.runId)).toBe(true);
      expect(r.index.all().every((x) => x.runId === b.runId)).toBe(true);
      expect(r.index.find("certificate", cert)).toHaveLength(1);
      expect(r.index.find("certificate", otherCert)).toEqual([]);
      expect(r.index.find("decision", other.decisions[0]!.id, other.runId)).toEqual([]);
      expect(r.counts.certificates).toBe(1);
    }
    // No run named and no real bundle: the run the question names picks the world.
    const byMention = retrieve(loaded, { question: `what happened in ${fxChange.runId}?` }, { certificatesDir: certsDir });
    if ("error" in byMention) throw new Error(byMention.error);
    expect(byMention.world).toBe("fixture:change-api");
  });

  it("a certificate whose source bundle hash differs from the loaded bundle is not citable", () => {
    const other = { ...fxDefault, contentHash: "0".repeat(64) };
    const r = retrieve([{ bundle: other, dir: loaded[0]!.dir }], { question: "certificates", runId: fxDefault.runId }, { certificatesDir: certsDir });
    if ("error" in r) throw new Error(r.error);
    expect(r.index.find("certificate", CERT_DEFAULT)).toEqual([]);
  });

  const askFx = (reply: unknown) =>
    answerQuestion(
      { question: "which dodo certificates were issued?", runId: fxDefault.runId },
      { bundleDirs: () => loaded.map((l) => l.dir), runsDir: join(fxRoot, "runs"), certificatesDir: certsDir, llm: fakeLlm(JSON.stringify(reply)) },
    );

  it("a certificate citation from the world's certificate file validates", async () => {
    const res = AskResponseSchema.parse(await askFx({ answer: "One dodo certificate.", citations: [{ kind: "certificate", id: CERT_DEFAULT, runId: fxDefault.runId }] }));
    expect(res).toMatchObject({ ok: true, citations: [expect.objectContaining({ kind: "certificate", id: CERT_DEFAULT })] });
  });

  it.each([
    ["a forged certificate id", { kind: "certificate", id: "cert-ffffffffffffffff", runId: "fx-default-run" }],
    ["the other scenario's certificate", { kind: "certificate", id: CERT_CHANGE }],
    ["a certificate cited as a revocation", { kind: "revocation", id: CERT_DEFAULT }],
  ])("%s is rejected", async (_label, citation) => {
    const res = AskResponseSchema.parse(await askFx({ answer: "x", citations: [citation] }));
    expect(res).toMatchObject({ ok: false, answer: ASK_FAILED_ANSWER });
  });

  it("timeline events and approvals of the world's runs are citable", async () => {
    const runDir = join(fxRoot, "runs", fxDefault.runId);
    const [ev] = appendTimelineEvents(runDir, [
      { runId: fxDefault.runId, at: "2026-10-10T12:00:00.000Z", stage: "enforce", type: "approval.decided", recordIds: ["appr-0000000000000001"], traceIds: [], summary: "test event" },
    ]);
    writeFileSync(
      join(runDir, "approvals.json"),
      JSON.stringify({
        runId: fxDefault.runId,
        approvals: [
          {
            id: "appr-0000000000000001",
            runId: fxDefault.runId,
            decisionId: "d",
            requestId: "q",
            action: "dodo.createRefund",
            decision: "rejected",
            reason: "test",
            humanOverride: true,
            effects: [],
            status: "closed",
            decidedAt: "2026-10-10T12:00:00.000Z",
          },
        ],
      }),
    );
    const res = AskResponseSchema.parse(
      await askFx({
        answer: "It was rejected.",
        citations: [
          { kind: "timeline_event", id: timelineEventId(fxDefault.runId, ev!.seq), runId: fxDefault.runId },
          { kind: "approval", id: "appr-0000000000000001", runId: fxDefault.runId },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    const forged = AskResponseSchema.parse(await askFx({ answer: "x", citations: [{ kind: "timeline_event", id: timelineEventId(fxDefault.runId, 999) }] }));
    expect(forged.ok).toBe(false);
  });
});
