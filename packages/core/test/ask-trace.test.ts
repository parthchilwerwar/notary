/**
 * neatlogs capture for Ask Notary (POST /api/ask): one trace per question, the span tree, what the
 * attributes may and may not carry, flushing, concurrency, the scoped local sink and the per-session
 * rate limit. The model is a real LlmClient over a fake Bedrock transport that opens an LLM span the
 * way the SDK's provider wrapper would (no network). Bundles are the synthetic sample bundle plus a
 * copy re-flagged as real (test data, never a run result).
 *
 * The last block runs the real neatlogs SDK against a local fake collector (127.0.0.1) and checks
 * the exported span tree from the SDK's own processed-span log.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ASK_RPM_ENV, DEFAULT_ASK_RPM, SlidingWindowLimiter, askRpm } from "../src/api/ask-limit.js";
import { ASK_SPANS_DIR, answerQuestion } from "../src/api/ask.js";
import type { AskOptions } from "../src/api/ask.js";
import { EventBus } from "../src/api/bus.js";
import { createApp } from "../src/api/server.js";
import { createSession } from "../src/api/session.js";
import type { CreatedSession } from "../src/api/session.js";
import { buildSampleBundle, finalizeBundle, writeBundle } from "../src/bundle/index.js";
import { LlmClient } from "../src/llm/client.js";
import type { ConverseTransport } from "../src/llm/client.js";
import { AskResponseSchema } from "../src/schema/explain.js";
import type { RunBundle } from "../src/schema/index.js";
import { initTracing, setSpanSink, shutdownTracing, withSpan } from "../src/trace/index.js";
import type { SpanRecord } from "../src/trace/index.js";

const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const PLANTED_ENV = "NOTARY_TEST_PLANTED_SECRET";
const PLANTED = "planted-s3cret-value-7f3a9c";
const MODEL_ENV = { NOTARY_MODEL_EXECUTOR: "test.executor-model-v1", AWS_REGION: "us-test-1" };

let root: string;
let sampleDir: string;
let realDir: string;
let real: RunBundle;
const dirs = () => [sampleDir, realDir];

beforeAll(async () => {
  process.env[PLANTED_ENV] = PLANTED;
  root = mkdtempSync(join(tmpdir(), "notary-ask-trace-"));
  sampleDir = join(root, "web");
  realDir = join(root, "runs", "real-run-1");
  const sample = buildSampleBundle(42);
  real = finalizeBundle({ ...sample, runId: "real-run-1", sample: false });
  await writeBundle(sample, sampleDir);
  await writeBundle(real, realDir);
});

afterAll(() => {
  delete process.env[PLANTED_ENV];
  rmSync(root, { recursive: true, force: true });
});

/** A Bedrock transport double that opens an LLM-kind span like wrapBedrock / wrapOpenAI would. */
function fakeTransport(reply: string | (() => string), opts: { delayMs?: number; fail?: Error } = {}): ConverseTransport & { calls: ConverseCommandInput[] } {
  const calls: ConverseCommandInput[] = [];
  const t = async (input: ConverseCommandInput): Promise<ConverseCommandOutput> => {
    calls.push(input);
    return await withSpan(
      "fake.provider.converse",
      { "llm.model_name": input.modelId ?? "" },
      async () => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.fail) throw opts.fail;
        const text = typeof reply === "string" ? reply : reply();
        return { output: { message: { role: "assistant", content: [{ text }] } }, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, stopReason: "end_turn", $metadata: {} } as ConverseCommandOutput;
      },
      { kind: "LLM" },
    );
  };
  return Object.assign(t, { calls });
}

const llmWith = (transport: ConverseTransport) => new LlmClient({ env: MODEL_ENV, transport });

function goodReply(): string {
  const d = real.decisions[0]!;
  return JSON.stringify({ answer: `It was ${d.status}.`, citations: [{ kind: "decision", id: d.id, runId: real.runId }] });
}
const question = () => `why was ${real.decisions[0]!.id} ${real.decisions[0]!.status}?`;

function readSpans(path: string): SpanRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SpanRecord);
}

function one(spans: SpanRecord[], name: string): SpanRecord {
  const hits = spans.filter((s) => s.name === name);
  expect(hits, name).toHaveLength(1);
  return hits[0]!;
}

let n = 0;
const sinkFile = () => join(root, "sinks", `ask-${++n}.jsonl`);
const noFlush = () => Promise.resolve(true);

describe("one trace per ask (local span sink)", () => {
  it("root + retrieve + validate, the LLM span nested under notary.llm under the root", async () => {
    const spansPath = sinkFile();
    const transport = fakeTransport(goodReply());
    const res = AskResponseSchema.parse(await answerQuestion({ question: question() }, { bundleDirs: dirs, llm: llmWith(transport), spansPath, flush: noFlush }));
    expect(res.ok).toBe(true);
    const spans = readSpans(spansPath);
    expect(spans.map((s) => s.name).sort()).toEqual(["fake.provider.converse", "notary.ask", "notary.ask.retrieve", "notary.ask.validate", "notary.llm"]);

    const ask = one(spans, "notary.ask");
    expect(ask).toMatchObject({ kind: "WORKFLOW", status: "ok" });
    expect(ask.parentSpanId).toBeUndefined();
    expect(res.traceId).toBe(ask.traceId);
    expect(spans.every((s) => s.traceId === ask.traceId)).toBe(true);

    const retrieve = one(spans, "notary.ask.retrieve");
    const llm = one(spans, "notary.llm");
    const validate = one(spans, "notary.ask.validate");
    const provider = one(spans, "fake.provider.converse");
    expect([retrieve.parentSpanId, llm.parentSpanId, validate.parentSpanId]).toEqual([ask.spanId, ask.spanId, ask.spanId]);
    expect(provider.parentSpanId).toBe(llm.spanId);
    expect([retrieve.kind, llm.kind, validate.kind, provider.kind]).toEqual(["RETRIEVER", "CHAIN", "GUARDRAIL", "LLM"]);
    // One capture owner: exactly one LLM span per model call.
    expect(spans.filter((s) => s.kind === "LLM")).toHaveLength(1);

    const d = real.decisions[0]!;
    expect(retrieve.attrs).toMatchObject({ "notary.ask.world": "real", "notary.ask.top_n": 12 });
    expect(retrieve.attrs["notary.ask.indexed"]).toBeGreaterThan(0);
    expect(retrieve.attrs["notary.ask.retrieved"]).toBeGreaterThan(0);
    const ids = String(retrieve.attrs["notary.ask.record_ids"]).split(",");
    expect(ids).toHaveLength(Number(retrieve.attrs["notary.ask.retrieved"]));
    expect(ids).toContain(`decision:${d.id}`);
    expect(ids.every((x) => /^[a-z_]+:[^,]+$/.test(x))).toBe(true);
    expect(String(retrieve.attrs["notary.ask.scores"]).split(",")).toHaveLength(ids.length);

    expect(llm.attrs).toMatchObject({ "notary.role": "executor", "llm.model_id": MODEL_ENV.NOTARY_MODEL_EXECUTOR, "llm.input_tokens": 11, "llm.output_tokens": 7 });
    expect(typeof llm.attrs["llm.usd"]).toBe("number");

    expect(validate.attrs).toMatchObject({
      "notary.ask.parse_ok": true,
      "notary.ask.cited": `decision:${d.id}`,
      "notary.ask.passed": `decision:${d.id}`,
      "notary.ask.failed": "",
      "notary.ask.failed_count": 0,
      "notary.ask.ok": true,
    });
    expect(ask.attrs).toMatchObject({ "notary.ask.ok": true, "notary.ask.citations_valid": true, "notary.ask.model_called": true, "notary.ask.blocked": false, "notary.ask.world": "real" });
  });

  it("a failed citation check lists the cited, passed and failed ids", async () => {
    const spansPath = sinkFile();
    const d = real.decisions[0]!;
    const reply = JSON.stringify({ answer: "held", citations: [{ kind: "decision", id: d.id, runId: real.runId }, { kind: "decision", id: "made-up", runId: real.runId }] });
    const res = await answerQuestion({ question: question() }, { bundleDirs: dirs, llm: llmWith(fakeTransport(reply)), spansPath, flush: noFlush });
    expect(res.ok).toBe(false);
    const spans = readSpans(spansPath);
    const validate = one(spans, "notary.ask.validate");
    expect(validate.attrs).toMatchObject({
      "notary.ask.cited": `decision:${d.id},decision:made-up`,
      "notary.ask.passed": `decision:${d.id}`,
      "notary.ask.failed": "decision:made-up",
      "notary.ask.failed_count": 1,
      "notary.ask.ok": false,
      "notary.ask.reason": "1 citation(s) do not resolve to a loaded record",
    });
    expect(one(spans, "notary.ask").attrs).toMatchObject({ "notary.ask.ok": false, "notary.ask.citations_valid": false });
  });

  it("BLOCKED (model not configured): retrieval + a skipped validation with the reason, no model span", async () => {
    const spansPath = sinkFile();
    const res = await answerQuestion({ question: question() }, { bundleDirs: dirs, env: {}, spansPath, flush: noFlush });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/^BLOCKED: NOTARY_MODEL_EXECUTOR not set/) });
    if (res.ok) return;
    const spans = readSpans(spansPath);
    expect(spans.map((s) => s.name).sort()).toEqual(["notary.ask", "notary.ask.retrieve", "notary.ask.validate"]);
    expect(one(spans, "notary.ask.retrieve").attrs["notary.ask.retrieved"]).toBeGreaterThan(0);
    expect(one(spans, "notary.ask.validate").attrs).toMatchObject({ "notary.ask.skipped": true, "notary.ask.ok": false, "notary.ask.reason": res.reason.slice(0, 200) });
    expect(one(spans, "notary.ask").attrs).toMatchObject({ "notary.ask.blocked": true, "notary.ask.model_called": false, "notary.ask.reason": res.reason.slice(0, 200) });
    expect(res.traceId).toBe(one(spans, "notary.ask").traceId);
  });

  it("a model call failure is traced (error on notary.llm, skipped validation), secrets scrubbed", async () => {
    const spansPath = sinkFile();
    const transport = fakeTransport("", { fail: new Error(`upstream rejected key ${PLANTED}`) });
    const res = await answerQuestion({ question: question() }, { bundleDirs: dirs, llm: llmWith(transport), spansPath, flush: noFlush });
    expect(res.ok).toBe(false);
    const spans = readSpans(spansPath);
    expect(one(spans, "notary.llm").status).toBe("error");
    expect(one(spans, "notary.ask.validate").attrs).toMatchObject({ "notary.ask.skipped": true });
    expect(String(one(spans, "notary.ask").attrs["notary.ask.reason"])).toMatch(/^model call failed:/);
    expect(readFileSync(spansPath, "utf8")).not.toContain(PLANTED);
  });

  it("never the question text, the prompt, the session token or a planted secret (over HTTP)", async () => {
    const spansPath = sinkFile();
    const session = createSession();
    const transport = fakeTransport(goodReply());
    const app = createApp({ bundleDirs: [sampleDir], runsDir: join(root, "runs"), bus: new EventBus(), session, ask: { llm: llmWith(transport), spansPath, flush: noFlush } });
    const q = `zebra-marker ${PLANTED} ${question()}`;
    const res = await app.request(
      "/api/ask",
      { method: "POST", headers: { Host: "127.0.0.1:8787", "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ question: q }) },
      LOOPBACK,
    );
    expect(res.status).toBe(200);
    expect(transport.calls).toHaveLength(1);
    const text = readFileSync(spansPath, "utf8");
    expect(text).toContain("notary.ask.retrieve");
    for (const forbidden of [session.token, PLANTED, "zebra-marker", "ONLY the records", "Records ("]) expect(text).not.toContain(forbidden);
    expect(one(readSpans(spansPath), "notary.ask").attrs["notary.ask.question_length"]).toBe(q.length);
  });
});

describe("flushing and concurrency", () => {
  it("starts exactly one flush per ask and never waits for it", async () => {
    const hang = vi.fn(() => new Promise<boolean>(() => {}));
    const res = await answerQuestion({ question: question() }, { bundleDirs: dirs, llm: llmWith(fakeTransport(goodReply())), spansPath: null, flush: hang });
    expect(res.ok).toBe(true);
    expect(hang).toHaveBeenCalledTimes(1);

    const failing = vi.fn(() => Promise.reject(new Error("export down")));
    const blocked = await answerQuestion({ question: question() }, { bundleDirs: dirs, env: {}, spansPath: null, flush: failing });
    expect(blocked.ok).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);

    const throwing = vi.fn((): Promise<boolean> => {
      throw new Error("sync export failure");
    });
    expect((await answerQuestion({ question: question() }, { bundleDirs: dirs, env: {}, spansPath: null, flush: throwing })).ok).toBe(false);
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("concurrent asks are separate traces whose spans never cross", async () => {
    const spansPath = sinkFile();
    const flush = vi.fn(noFlush);
    const asks = [30, 5, 15].map((delayMs) =>
      answerQuestion({ question: question() }, { bundleDirs: dirs, llm: llmWith(fakeTransport(goodReply(), { delayMs })), spansPath, flush }),
    );
    const results = await Promise.all(asks);
    expect(flush).toHaveBeenCalledTimes(3);
    const traceIds = results.map((r) => r.traceId);
    expect(new Set(traceIds).size).toBe(3);
    const spans = readSpans(spansPath);
    expect(spans).toHaveLength(15);
    for (const id of traceIds) {
      const tree = spans.filter((s) => s.traceId === id);
      expect(tree.map((s) => s.name).sort()).toEqual(["fake.provider.converse", "notary.ask", "notary.ask.retrieve", "notary.ask.validate", "notary.llm"]);
      const ids = new Set(tree.map((s) => s.spanId));
      expect(tree.filter((s) => s.parentSpanId !== undefined).every((s) => ids.has(s.parentSpanId!))).toBe(true);
    }
  });

  it("ask spans stay in the ask sink while something else swaps the global sink (approvals)", async () => {
    const askPath = sinkFile();
    const approvalPath = join(root, "runs", "real-run-1", "spans-test-approval.jsonl");
    const ask = answerQuestion({ question: question() }, { bundleDirs: dirs, llm: llmWith(fakeTransport(goodReply(), { delayMs: 20 })), spansPath: askPath, flush: noFlush });
    setSpanSink(approvalPath);
    try {
      await withSpan("notary.approval", { "notary.approval.id": "appr-test" }, async () => await new Promise((r) => setTimeout(r, 10)));
      await ask;
    } finally {
      setSpanSink(null);
    }
    expect(readSpans(approvalPath).map((s) => s.name)).toEqual(["notary.approval"]);
    expect(readSpans(askPath).some((s) => s.name === "notary.approval")).toBe(false);
    expect(readSpans(askPath)).toHaveLength(5);
  });

  it("createApp sinks ask spans in <runsDir>/_ask/spans.jsonl", async () => {
    const runsDir = join(root, "runs-sink");
    const session = createSession();
    const app = createApp({ bundleDirs: [sampleDir], runsDir, bus: new EventBus(), session, ask: { env: {}, flush: noFlush } });
    const res = await app.request(
      "/api/ask",
      { method: "POST", headers: { Host: "127.0.0.1:8787", "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ question: "why was q01 held?" }) },
      LOOPBACK,
    );
    expect(res.status).toBe(200);
    expect(readSpans(join(runsDir, ASK_SPANS_DIR, "spans.jsonl")).map((s) => s.name).sort()).toEqual(["notary.ask", "notary.ask.retrieve", "notary.ask.validate"]);
  });
});

describe("rate limit (NOTARY_ASK_RPM per session)", () => {
  const post = (app: ReturnType<typeof createApp>, session: CreatedSession, body: unknown = { question: question() }) =>
    app.request(
      "/api/ask",
      { method: "POST", headers: { Host: "127.0.0.1:8787", "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: JSON.stringify(body) },
      LOOPBACK,
    );

  function setup(ask: Omit<AskOptions, "bundleDirs"> = {}) {
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
    const session = createSession();
    const transport = fakeTransport(goodReply());
    const spansPath = sinkFile();
    const flush = vi.fn(noFlush);
    const app = createApp({ bundleDirs: [sampleDir], runsDir: join(root, "runs"), bus: new EventBus(), session, ask: { llm: llmWith(transport), now: clock.now, spansPath, flush, ...ask } });
    return { app, session, transport, clock, spansPath, flush };
  }

  it("N allowed, then 429 + Retry-After with no model call, and a short trace of the rejected ask", async () => {
    const { app, session, transport, clock, spansPath, flush } = setup({ rpm: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await post(app, session)).status).toBe(200);
      clock.advance(1_000);
    }
    const res = await post(app, session);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("57"); // asks at t0, t0+1s, t0+2s; now t0+3s: free again at t0+60s
    expect(await res.json()).toEqual({ error: "rate limited: at most 3 questions per minute (NOTARY_ASK_RPM)" });
    expect(transport.calls).toHaveLength(3);
    expect(flush).toHaveBeenCalledTimes(4);

    const limited = readSpans(spansPath).filter((s) => s.attrs["notary.ask.rate_limited"] === true);
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ name: "notary.ask", kind: "WORKFLOW" });
    expect(limited[0]!.parentSpanId).toBeUndefined();
    expect(limited[0]!.attrs).toMatchObject({ "notary.ask.rpm": 3, "notary.ask.retry_after_s": 57, "notary.ask.ok": false, "notary.ask.model_called": false });
    // Only the root: no retrieval, no model, no validation in that trace.
    expect(readSpans(spansPath).filter((s) => s.traceId === limited[0]!.traceId)).toHaveLength(1);
    expect(readFileSync(spansPath, "utf8")).not.toContain(session.token);
  });

  it("the window slides; 400s and 429s use no slot", async () => {
    const { app, session, clock } = setup({ rpm: 2 });
    expect((await post(app, session, { question: "" })).status).toBe(400);
    expect((await post(app, session)).status).toBe(200); // t0
    clock.advance(20_000);
    expect((await post(app, session)).status).toBe(200); // t0+20s
    clock.advance(20_000);
    const limited = await post(app, session); // t0+40s
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("20");
    clock.advance(20_001); // t0+60.001s: the first ask left the window
    expect((await post(app, session)).status).toBe(200);
    const again = await post(app, session); // window holds t0+20s and t0+60.001s
    expect(again.status).toBe(429);
    expect(again.headers.get("Retry-After")).toBe("20");
  });

  it("each session has its own counter; approvals are not limited", async () => {
    const a = setup({ rpm: 1 });
    const b = setup({ rpm: 1 });
    expect((await post(a.app, a.session)).status).toBe(200);
    expect((await post(a.app, a.session)).status).toBe(429);
    expect((await post(b.app, b.session)).status).toBe(200);
    // Another session's token is refused by a's server (401), and never touches a's counter.
    expect((await post(a.app, b.session)).status).toBe(401);
    const approvals = await a.app.request("/api/approvals", { method: "GET", headers: { Host: "127.0.0.1:8787", Authorization: `Bearer ${a.session.token}` } }, LOOPBACK);
    expect(approvals.status).not.toBe(429);
  });

  it("NOTARY_ASK_RPM: default 10, a positive integer, anything else falls back with a problem", () => {
    expect(askRpm({})).toEqual({ rpm: DEFAULT_ASK_RPM });
    expect(DEFAULT_ASK_RPM).toBe(10);
    expect(askRpm({ [ASK_RPM_ENV]: " 25 " })).toEqual({ rpm: 25 });
    for (const bad of ["0", "-3", "2.5", "ten"]) expect(askRpm({ [ASK_RPM_ENV]: bad })).toMatchObject({ rpm: 10, problem: expect.stringContaining(ASK_RPM_ENV) });
    expect(askRpm({ [ASK_RPM_ENV]: "50" }, 4)).toEqual({ rpm: 4 });
  });

  it("the limiter is a sliding window on the injected clock", () => {
    let t = 0;
    const l = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, now: () => t });
    expect([l.take().ok, l.take().ok]).toEqual([true, true]);
    expect(l.take()).toEqual({ ok: false, retryAfterMs: 1000 });
    t = 999;
    expect(l.take()).toEqual({ ok: false, retryAfterMs: 1 });
    t = 1000;
    expect(l.take().ok).toBe(true);
  });
});

/** The real SDK, exporting to a local fake collector; the tree is read from the SDK's processed-span log. */
describe("with the neatlogs SDK on (local fake collector)", () => {
  type SdkSpan = { trace_id: string; span_id: string; parent_span_id: string | null; name: string; kind: string; attributes: Record<string, unknown> };
  const ENV_KEYS = ["NEATLOGS_API_KEY", "NEATLOGS_ENDPOINT", "NEATLOGS_LOG_SPANS", "NEATLOGS_LOG_SPANS_FILE", "NEATLOGS_DISABLE_EXPORT"] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const bodies: Buffer[] = [];
  let collector: Server;
  let logFile: string;
  let enabled = false;

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    collector = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "POST" && (req.url ?? "").startsWith("/v1/traces")) {
          const raw = Buffer.concat(chunks);
          try {
            bodies.push(req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw);
          } catch {
            bodies.push(raw);
          }
        }
        res.writeHead(200, { "Content-Type": "application/x-protobuf" });
        res.end();
      });
    });
    await new Promise<void>((r) => collector.listen(0, "127.0.0.1", () => r()));
    const addr = collector.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    logFile = join(root, "sdk", "processed-spans.log");
    process.env.NEATLOGS_API_KEY = "nl-fake-test-key-not-real-0001";
    process.env.NEATLOGS_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.NEATLOGS_LOG_SPANS = "true";
    process.env.NEATLOGS_LOG_SPANS_FILE = logFile;
    delete process.env.NEATLOGS_DISABLE_EXPORT;
    enabled = (await initTracing({ serviceName: "ask-trace-test" })).enabled;
  });

  afterAll(async () => {
    await shutdownTracing();
    collector.closeAllConnections();
    await new Promise<void>((r) => collector.close(() => r()));
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Generous limits: under full-suite parallel load the SDK export can take seconds; the assertion is
  // that the flush happens before shutdown, not how fast.
  it("exports one tree per ask, nested by context, flushed without waiting for exit", { timeout: 30_000 }, async () => {
    expect(enabled).toBe(true);
    const session = createSession();
    const spansPath = sinkFile();
    const ask = (delayMs: number) =>
      createApp({ bundleDirs: [sampleDir, realDir], runsDir: null, bus: new EventBus(), session, ask: { llm: llmWith(fakeTransport(goodReply(), { delayMs })), spansPath } }).request(
        "/api/ask",
        { method: "POST", headers: { Host: "127.0.0.1:8787", "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ question: `${PLANTED} ${question()}` }) },
        LOOPBACK,
      );
    const responses = await Promise.all([ask(25), ask(5)]);
    const answers = await Promise.all(responses.map(async (r) => AskResponseSchema.parse(await r.json())));
    expect(answers.map((a) => a.ok)).toEqual([true, true]);
    const traceIds = answers.map((a) => a.traceId!);
    expect(new Set(traceIds).size).toBe(2);

    // The per-ask flush reaches the collector while the process keeps running (no shutdown yet).
    const deadline = Date.now() + 20_000;
    while (!bodies.some((b) => b.includes("notary.ask.validate")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(bodies.some((b) => b.includes("notary.ask.validate"))).toBe(true);
    // The local receipts say these traces were exported.
    const local = readSpans(spansPath);
    expect(local.filter((s) => s.name === "notary.ask").every((s) => s.exported === true)).toBe(true);
    expect(local.filter((s) => s.name === "notary.ask").map((s) => s.traceId).sort()).toEqual([...traceIds].sort());

    await shutdownTracing(); // closes the SDK's span log
    const exported = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SdkSpan);
    for (const id of traceIds) {
      const tree = exported.filter((s) => s.trace_id === id);
      const by = (name: string) => {
        const hits = tree.filter((s) => s.name === name);
        expect(hits, name).toHaveLength(1);
        return hits[0]!;
      };
      const rootSpan = by("notary.ask");
      expect(rootSpan.parent_span_id).toBeNull();
      for (const name of ["notary.ask.retrieve", "notary.llm", "notary.ask.validate"]) expect(by(name).parent_span_id).toBe(rootSpan.span_id);
      expect(by("fake.provider.converse").parent_span_id).toBe(by("notary.llm").span_id);
      expect(tree.map((s) => s.name).sort()).toEqual(["fake.provider.converse", "notary.ask", "notary.ask.retrieve", "notary.ask.validate", "notary.llm"]);
      expect(String(by("notary.ask.retrieve").attributes["notary.ask.record_ids"])).toContain("decision:");
      expect(by("notary.llm").attributes).toMatchObject({ "notary.role": "executor", "llm.input_tokens": 11, "llm.output_tokens": 7 });
    }
    const everything = [readFileSync(logFile, "utf8"), ...bodies.map((b) => b.toString("latin1"))].join("\n");
    expect(everything).not.toContain(session.token);
    expect(everything).not.toContain(PLANTED);
  });
});
