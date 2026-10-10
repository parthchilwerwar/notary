/**
 * Redesign R1: `notary serve` endpoints backed by the real agent (src/api/{health,runs,certificates}.ts,
 * approvals by id). TEST DOUBLES ONLY for integrations (test/fakes.ts world, probe doubles): no
 * network. The "real" run here is a real guarded runQueue over the in-memory fake Dodo; the sample /
 * fixture bundles are written only to prove they never appear in a live response.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bus as processBus } from "../src/api/bus.js";
import { approvalIdFor } from "../src/api/approvals.js";
import type { HealthProbes } from "../src/api/health.js";
import type { RunTracker, RunnerResult } from "../src/api/runs.js";
import { createApp } from "../src/api/server.js";
import type { ApiOptions } from "../src/api/server.js";
import { createSession } from "../src/api/session.js";
import { buildSampleBundle, verifyBundle, writeBundle } from "../src/bundle/index.js";
import type { SeedManifest } from "../src/queue/manifest.js";
import { runQueue } from "../src/queue/run.js";
import {
  CertificatesResponseSchema,
  HealthResponseSchema,
  RunsListResponseSchema,
  StartRunResponseSchema,
} from "../src/schema/api.js";
import type { HealthResponse, IntegrationStatus } from "../src/schema/api.js";
import { ApprovalRecordSchema, ApprovalsListSchema } from "../src/schema/approval.js";
import type { QueueRequest } from "../src/schema/index.js";
import { TimelineEventSchema } from "../src/schema/timeline.js";
import type { TimelineEvent } from "../src/schema/timeline.js";
import { NotaryDb } from "../src/store/db.js";
import { readTimeline } from "../src/timeline/store.js";
import { ToolHttpError } from "../src/tools/index.js";
import { FakeDodo, T0, fakeWorld, req, testManifest, testPolicy } from "./fakes.js";

const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const REMOTE = { incoming: { socket: { remoteAddress: "203.0.113.9" } } };
const session = createSession();
const auth = () => ({ Host: "localhost:8787", Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" });

const manifest: SeedManifest = {
  ...testManifest,
  payments: {
    p1: { paymentId: "pay_1", customerHandle: "a", amount: 2900, currency: "USD", status: "succeeded" },
    p3: { paymentId: "pay_3", customerHandle: "a", amount: 4900, currency: "USD", status: "succeeded" },
  },
};
const queue: QueueRequest[] = [
  req("r1", { paymentId: "pay:p1", currency: "USD" }),
  req("c1", { type: "credit", paymentId: undefined, amount: 500, currency: "USD" }),
  req("s1", { type: "plan_change", paymentId: undefined, subscriptionId: "sub_1", targetPlan: "growth" }),
];
const KEYED_TEST_ENV = { NOTARY_MODE: "test", DODO_PAYMENTS_API_KEY: "fake-dodo-key-for-serve-r1-tests" };

let root: string;
let webDir: string;
let runsDir: string;
let queueFile: string;
let realRunId: string;
let w: FakeDodo;
let db: NotaryDb;

/** Probe doubles that fail the test if any network check runs. */
function forbiddenProbes(calls: string[]): HealthProbes {
  const no = (what: string) => async () => {
    calls.push(what);
    throw new Error(`${what}: no network in tests`);
  };
  return { listModels: no("listModels"), crustdata: no("crustdata"), dodo: no("dodo"), entireOnPath: () => false, tracing: () => ({ init: null, lastFlush: null, exportedTraces: 0 }) };
}

function app(extra: Partial<ApiOptions> = {}) {
  return createApp({
    bundleDirs: [webDir],
    runsDir,
    session,
    keepAliveMs: 60_000,
    health: { env: {}, probes: forbiddenProbes([]) },
    runs: { env: {} },
    approvals: { env: {}, db, manifest, makeTools: (wrap) => w.tools(wrap), decidePolicy: testPolicy.decidePolicy, now: () => new Date(T0) },
    ...extra,
  });
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until: (text: string) => boolean, timeoutMs = 4000): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for SSE text; got:\n${text}`);
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for SSE text; got:\n${text}`)), remaining)),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

type SseFrame = { event?: string; id?: string; data?: string };
function frames(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .map((block) => {
      const f: SseFrame = {};
      for (const line of block.split("\n")) {
        const m = /^(event|id|data): ?(.*)$/.exec(line);
        if (m) f[m[1] as keyof SseFrame] = m[2];
      }
      return f;
    })
    .filter((f) => f.event !== undefined || f.data !== undefined);
}

function byName(h: HealthResponse, name: IntegrationStatus["name"]): IntegrationStatus {
  return h.integrations.find((i) => i.name === name)!;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "notary-serve-r1-"));
  webDir = join(root, "web");
  runsDir = join(root, "runs");
  // Sample / fixture data the live endpoints must never return: a SAMPLE bundle in the published dir,
  // fixture bundles in its fixture/ subdirectory (own index) and a SAMPLE bundle under runs/.
  await writeBundle(buildSampleBundle(42), webDir);
  await writeBundle(buildSampleBundle(5), join(webDir, "fixture"));
  await writeBundle(buildSampleBundle(7), join(runsDir, "sample-7"));

  queueFile = join(root, "queue.json");
  writeFileSync(queueFile, JSON.stringify(queue));
  writeFileSync(join(root, "expected.json"), JSON.stringify(queue.map((r) => ({ requestId: r.id, expectedTier: "smb", expectedOutcome: "approve", expectedAction: "none" }))));
  w = fakeWorld();
  db = new NotaryDb(":memory:");
  // A real guarded run over the fake world; no notarized beliefs, so every write is held.
  const res = await runQueue({ queueFile, variant: "guarded", mode: "live", manifest, makeTools: (wrap) => w.tools(wrap), policy: testPolicy, db, runsDir, webBundlesDir: null, now: () => new Date(T0) });
  expect(res.exitCode).toBe(0);
  realRunId = res.runId!;
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------- health

describe("GET /api/health", () => {
  it("with every key unset: each integration reports the missing variable and an exact fix; no network call", async () => {
    const calls: string[] = [];
    const res = await app({ health: { env: {}, probes: forbiddenProbes(calls) } }).request("/api/health");
    expect(res.status).toBe(200);
    const h = HealthResponseSchema.parse(await res.json());
    expect(h.integrations.map((i) => i.name)).toEqual(["llm", "crustdata", "dodo", "neatlogs", "entire"]);
    expect(h.integrations.map((i) => [i.name, i.state, i.label])).toEqual([
      ["llm", "missing", "missing AWS_REGION"], // provider unset = bedrock
      ["crustdata", "missing", "missing CRUSTDATA_API_KEY"],
      ["dodo", "missing", "missing DODO_PAYMENTS_API_KEY"],
      ["neatlogs", "missing", "missing NEATLOGS_API_KEY"],
      ["entire", "missing", "missing entire"],
    ]);
    for (const i of h.integrations) {
      expect(i.variable).toBeTruthy();
      expect(i.fix).toMatch(/\S/);
    }
    expect(byName(h, "crustdata").fix).toMatch(/Set CRUSTDATA_API_KEY in \.env/);
    expect(byName(h, "entire").fix).toMatch(/Install the Entire CLI/);
    expect(byName(h, "llm").detail).toMatch(/NOTARY_MODEL_EXECUTOR/);
    expect(calls).toEqual([]);
  });

  it("names the LLM variable per provider (litellm: base URL, then key)", async () => {
    const one = async (env: NodeJS.ProcessEnv) =>
      byName(HealthResponseSchema.parse(await (await app({ health: { env, probes: forbiddenProbes([]) } }).request("/api/health")).json()), "llm").label;
    expect(await one({ NOTARY_LLM_PROVIDER: "litellm" })).toBe("missing LITELLM_BASE_URL");
    expect(await one({ NOTARY_LLM_PROVIDER: "litellm", LITELLM_BASE_URL: "https://proxy.example/v1" })).toBe("missing LITELLM_API_KEY");
    expect(await one({ NOTARY_LLM_PROVIDER: "litellm", LITELLM_BASE_URL: "https://proxy.example", LITELLM_API_KEY: "k-123456789" })).toBe("missing NOTARY_MODEL_EXECUTOR");
    expect(await one({ NOTARY_LLM_PROVIDER: "bogus" })).toMatch(/^error NOTARY_LLM_PROVIDER/);
  });

  it("connected only after a real (here: double) zero-cost check; cached for the TTL; secrets scrubbed everywhere", async () => {
    const SECRETS = { LITELLM_API_KEY: "litellm-secret-value-0001", CRUSTDATA_API_KEY: "crust-secret-value-0002", DODO_PAYMENTS_API_KEY: "dodo-secret-value-0003", NEATLOGS_API_KEY: "neat-secret-value-0004" };
    const env = {
      ...SECRETS,
      NOTARY_MODE: "test",
      NOTARY_LLM_PROVIDER: "litellm",
      LITELLM_BASE_URL: "https://proxy.example/v1",
      NOTARY_MODEL_EXECUTOR: "m-exec",
      NOTARY_MODEL_REFLECTOR: "m-refl",
      NOTARY_MODEL_ADVERSARY: "m-adv",
    };
    const calls: string[] = [];
    let t = 0;
    const probes: HealthProbes = {
      listModels: async (baseUrl, key) => {
        calls.push(`models ${baseUrl}`);
        expect(key).toBe(SECRETS.LITELLM_API_KEY);
        return ["m-exec", "m-refl", "m-adv"];
      },
      crustdata: async () => void calls.push("crustdata"),
      // An error that echoes the key: it must never reach the response.
      dodo: async () => {
        calls.push("dodo");
        throw new Error(`upstream said: bad token ${SECRETS.DODO_PAYMENTS_API_KEY}`);
      },
      entireOnPath: () => true,
      tracing: () => ({ init: { enabled: true }, lastFlush: { ok: true, at: T0 }, exportedTraces: 2 }),
    };
    const a = app({ health: { env, probes, clock: () => t } });
    const get = async () => {
      const res = await a.request("/api/health");
      const text = await res.text();
      for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
      return HealthResponseSchema.parse(JSON.parse(text));
    };
    const h = await get();
    expect(h.integrations.map((i) => [i.name, i.state])).toEqual([
      ["llm", "connected"],
      ["crustdata", "connected"],
      ["dodo", "error"],
      ["neatlogs", "connected"],
      ["entire", "connected"],
    ]);
    expect(byName(h, "dodo").label).toMatch(/^error Dodo GET \/customers: .*\[REDACTED\]/);
    expect(byName(h, "llm").label).toBe("connected");
    expect(calls).toEqual(["models https://proxy.example/v1", "crustdata", "dodo"]);
    await get();
    expect(calls).toHaveLength(3); // cached
    t = 61_000;
    await get();
    expect(calls).toHaveLength(6); // re-checked after the TTL
  });

  it("errors: rejected key, model not offered, Dodo test-mode lock off, neatlogs SDK only initialized", async () => {
    const base = { NOTARY_LLM_PROVIDER: "litellm", LITELLM_BASE_URL: "https://p.example", LITELLM_API_KEY: "kkkkkkkkkk", NOTARY_MODEL_EXECUTOR: "a", NOTARY_MODEL_REFLECTOR: "b", NOTARY_MODEL_ADVERSARY: "c" };
    const h1 = HealthResponseSchema.parse(
      await (
        await app({
          health: {
            env: { ...base, DODO_PAYMENTS_API_KEY: "x".repeat(12), CRUSTDATA_API_KEY: "y".repeat(12), NEATLOGS_API_KEY: "z".repeat(12) },
            probes: {
              listModels: async () => Promise.reject(Object.assign(new Error("401 unauthorized"), { status: 401 })),
              crustdata: async () => Promise.reject(new ToolHttpError("crustdata.getCreditBalance", 401, {}, "x")),
              dodo: async () => undefined,
              entireOnPath: () => false,
              tracing: () => ({ init: { enabled: true }, lastFlush: null, exportedTraces: 0 }),
            },
          },
        }).request("/api/health")
      ).json(),
    );
    expect(byName(h1, "llm").label).toBe("error the LiteLLM proxy rejected LITELLM_API_KEY (HTTP 401)");
    expect(byName(h1, "crustdata").label).toBe("error Crustdata rejected CRUSTDATA_API_KEY (HTTP 401)");
    expect(byName(h1, "dodo").label).toMatch(/^error Dodo test-mode lock: NOTARY_MODE/);
    expect(byName(h1, "dodo").fix).toMatch(/NOTARY_MODE=test/);
    expect(byName(h1, "neatlogs").state).toBe("configured");

    const h2 = HealthResponseSchema.parse(
      await (await app({ health: { env: base, probes: { ...forbiddenProbes([]), listModels: async () => ["a", "b"] } } }).request("/api/health")).json(),
    );
    expect(byName(h2, "llm").label).toBe('error NOTARY_MODEL_ADVERSARY "c" is not offered by the proxy for this key');
    const h3 = HealthResponseSchema.parse(
      await (await app({ health: { env: { AWS_REGION: "us-east-1", NOTARY_MODEL_EXECUTOR: "a", NOTARY_MODEL_REFLECTOR: "b", NOTARY_MODEL_ADVERSARY: "c" }, probes: forbiddenProbes([]) } }).request("/api/health")).json(),
    );
    expect(byName(h3, "llm").state).toBe("configured"); // bedrock: no zero-cost check exists
  });
});

// --------------------------------------------------------------------------------------- runs

describe("POST /api/runs", () => {
  it("BLOCKED (503) with every key unset: the exact message naming the variable, nothing created, no runner called", async () => {
    let called = 0;
    const runner = async (): Promise<RunnerResult> => {
      called++;
      return { exitCode: 0, lines: [], status: "completed" };
    };
    const a = app({ runs: { env: {}, runQueue: runner, notarize: runner } });
    const before = readdirSync(runsDir).sort();
    const q = await a.request("/api/runs", { method: "POST", headers: auth(), body: JSON.stringify({ kind: "queue", variant: "guarded" }) }, LOOPBACK);
    expect(q.status).toBe(503);
    const qb = (await q.json()) as { error: string; blocked: string[] };
    expect(qb.error).toBe("BLOCKED: DODO_PAYMENTS_API_KEY not set");
    expect(qb.blocked).toContain("BLOCKED: CRUSTDATA_API_KEY not set");
    expect(qb.blocked.some((l) => /test-mode lock/.test(l))).toBe(true);
    const n = await a.request("/api/runs", { method: "POST", headers: auth(), body: JSON.stringify({ kind: "notarize", tool: "crustdata" }) }, LOOPBACK);
    expect(n.status).toBe(503);
    const nb = (await n.json()) as { error: string; blocked: string[] };
    expect(nb.error).toBe("BLOCKED: CRUSTDATA_API_KEY not set");
    expect(nb.blocked.some((l) => l.startsWith("BLOCKED: NOTARY_MODEL_REFLECTOR not set"))).toBe(true);
    expect(called).toBe(0);
    expect(readdirSync(runsDir).sort()).toEqual(before);
    const list = RunsListResponseSchema.parse(await (await a.request("/api/runs")).json());
    expect(list.runs.some((r) => r.state === "running")).toBe(false);
  });

  it("token + localhost: 401 without the token, 403 from a non-loopback socket, 400 on a bad body", async () => {
    const a = app();
    const body = JSON.stringify({ kind: "queue", variant: "guarded" });
    expect((await a.request("/api/runs", { method: "POST", headers: { Host: "localhost:8787", "Content-Type": "application/json" }, body }, LOOPBACK)).status).toBe(401);
    expect((await a.request("/api/runs", { method: "POST", headers: auth(), body }, REMOTE)).status).toBe(403);
    expect((await a.request("/api/runs", { method: "POST", headers: { ...auth(), Host: "evil.example" }, body }, LOOPBACK)).status).toBe(403);
    expect((await a.request("/api/runs", { method: "POST", headers: auth(), body: JSON.stringify({ kind: "queue", variant: "fast" }) }, LOOPBACK)).status).toBe(400);
    expect((await a.request("/api/runs", { method: "POST", headers: auth(), body: "nope" }, LOOPBACK)).status).toBe(400);
  });

  it("starts a real run in the background: 202 running, 409 on a second start, live SSE, then the verified bundle", async () => {
    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    const w2 = fakeWorld();
    const db2 = new NotaryDb(":memory:");
    let tracker!: RunTracker;
    // Its own runs dir, so this run never shows up in the other tests' listings.
    const liveRunsDir = join(root, "runs-live");
    const a = createApp({
      bundleDirs: [webDir],
      runsDir: liveRunsDir,
      session,
      keepAliveMs: 60_000,
      onRunTracker: (t) => (tracker = t),
      runs: {
        env: {},
        precheck: () => [],
        // The real agent (runQueue) over the fake world; the server picks the runId.
        runQueue: async ({ runId, runsDir: dir, variant }) => {
          await latch;
          return await runQueue({ queueFile, variant, mode: "live", runId, manifest, makeTools: (wrap) => w2.tools(wrap), policy: testPolicy, db: db2, runsDir: dir, webBundlesDir: null });
        },
      },
    });
    try {
      const start = await a.request("/api/runs", { method: "POST", headers: auth(), body: JSON.stringify({ kind: "queue", variant: "guarded" }) }, LOOPBACK);
      expect(start.status).toBe(202);
      const { runId } = StartRunResponseSchema.parse(await start.json());
      expect(runId).toMatch(/^run-guarded-\d{8}T\d{6}Z$/);

      const again = await a.request("/api/runs", { method: "POST", headers: auth(), body: JSON.stringify({ kind: "queue", variant: "guarded" }) }, LOOPBACK);
      expect(again.status).toBe(409);

      const listed = RunsListResponseSchema.parse(await (await a.request("/api/runs")).json());
      expect(listed.runs.find((r) => r.runId === runId)).toMatchObject({ state: "running", kind: "run" });
      const pending = await a.request(`/api/runs/${runId}`);
      expect(pending.status).toBe(202);
      expect(await pending.json()).toEqual({ runId, state: "running" });

      // SSE on the running run: nothing recorded yet, live events while it runs, final events, then end.
      const sse = await a.request(`/api/runs/${runId}/events`);
      expect(sse.status).toBe(200);
      const reader = sse.body!.getReader();
      await readUntil(reader, (t) => t.includes(": connected"));
      release();
      const text = await readUntil(reader, (t) => t.includes("event: end"));
      await reader.cancel();
      const fs = frames(text);
      const timeline = fs.filter((f) => f.event === "timeline").map((f) => ({ id: f.id, e: TimelineEventSchema.parse(JSON.parse(f.data!)) }));
      expect(timeline.every((x) => x.e.runId === runId)).toBe(true);
      const live = timeline.filter((x) => x.e.data?.live === true);
      expect(live.length).toBeGreaterThan(0);
      expect(live.every((x) => x.id === undefined)).toBe(true);
      const final = timeline.filter((x) => x.e.data?.live !== true);
      const file = readTimeline(join(liveRunsDir, runId));
      expect(final.map((x) => x.e.seq)).toEqual(file.map((e) => e.seq)); // each final event once, by seq
      expect(final.map((x) => x.id)).toEqual(file.map((e) => String(e.seq)));
      expect(final.at(-1)!.e.type).toBe("run.finished");
      expect(JSON.parse(fs.at(-1)!.data!)).toMatchObject({ runId, state: "finished" });

      await new Promise<void>((r) => tracker.onEnd(runId, r));
      expect(tracker.get(runId)!.state).toBe("finished");
      const done = await a.request(`/api/runs/${runId}`);
      expect(done.status).toBe(200);
      const v = verifyBundle(await done.json());
      expect(v.ok && v.bundle.runId).toBe(runId);
      const after = RunsListResponseSchema.parse(await (await a.request("/api/runs")).json());
      expect(after.runs.filter((r) => r.runId === runId)).toEqual([expect.objectContaining({ state: "finished", sample: false, kind: "run" })]);
    } finally {
      release();
      db2.close();
    }
  });

  it("a run that throws or ends blocked never crashes serve; its state and reason are readable", async () => {
    let tracker!: RunTracker;
    const a = app({
      onRunTracker: (t) => (tracker = t),
      runs: {
        env: { CRUSTDATA_API_KEY: "crust-secret-value-9999" },
        precheck: () => [],
        runQueue: async () => {
          throw new Error("boom with crust-secret-value-9999 inside");
        },
        notarize: async () => ({ exitCode: 3, lines: ["BLOCKED: NOTARY_MAX_USD reached before the first probe"], status: "blocked" }),
      },
    });
    const q = StartRunResponseSchema.parse(await (await a.request("/api/runs", { method: "POST", headers: auth(), body: JSON.stringify({ kind: "queue", variant: "naive" }) }, LOOPBACK)).json());
    const n = StartRunResponseSchema.parse(await (await a.request("/api/runs", { method: "POST", headers: auth(), body: JSON.stringify({ kind: "notarize", tool: "dodo" }) }, LOOPBACK)).json());
    await Promise.all([q.runId, n.runId].map((id) => new Promise<void>((r) => tracker.onEnd(id, r))));
    const failed = await a.request(`/api/runs/${q.runId}`);
    expect(failed.status).toBe(500);
    const fb = await failed.text();
    expect(fb).toContain('"state":"failed"');
    expect(fb).not.toContain("crust-secret-value-9999");
    const blocked = await a.request(`/api/runs/${n.runId}`);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ state: "blocked", error: "BLOCKED: NOTARY_MAX_USD reached before the first probe" });
    // Ended runs without a bundle are not listed; the server still answers.
    const list = RunsListResponseSchema.parse(await (await a.request("/api/runs")).json());
    expect(list.runs.map((r) => r.runId)).not.toContain(q.runId);
    expect((await a.request("/api/runs/does-not-exist")).status).toBe(404);
  });
});

// ------------------------------------------------------------------- no sample / fixture data

describe("live responses never carry sample / fixture data", () => {
  it("GET /api/runs lists only the real run", async () => {
    const res = await app().request("/api/runs");
    const list = RunsListResponseSchema.parse(await res.json());
    expect(list.runs.map((r) => r.runId)).toEqual([realRunId]);
    expect(list.runs.every((r) => "sample" in r && r.sample === false)).toBe(true);
    expect((await app().request("/api/runs/sample-42")).status).toBe(404);
    expect((await app().request("/api/runs/sample-7/events")).status).toBe(404);
  });

  it("GET /api/certificates is built from real bundles only (honest 'not tested' when none qualify)", async () => {
    const res = await app().request("/api/certificates");
    expect(res.status).toBe(200);
    const body = CertificatesResponseSchema.parse(await res.json());
    expect(body.world).toBe("real");
    expect(body.tools.map((t) => t.tool)).toEqual(["crustdata", "dodo"]);
    for (const t of body.tools) {
      expect(t.sample).toBe(false);
      expect(t.disclosure).toEqual([]);
      expect(t.sourceBundles.every((s) => !s.sample && !s.runId.startsWith("sample-"))).toBe(true);
      expect(t.certificates.every((c) => !c.sample)).toBe(true);
    }
    expect(body.report?.sample).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/sample-(42|5|7)|FIXTURE/);
    expect((await app().request("/api/certificates/cert-0000000000000000")).status).toBe(404);
    expect((await app().request("/api/certificates/nope")).status).toBe(400);
  });

  it("GET /api/approvals lists only items of the real run, each with its id", async () => {
    const res = await app().request("/api/approvals", { headers: auth() }, LOOPBACK);
    const l = ApprovalsListSchema.parse(await res.json());
    expect(l.pending.length).toBe(3);
    for (const p of l.pending) {
      expect(p.runId).toBe(realRunId);
      expect(p.id).toBe(approvalIdFor(p.runId, p.decisionId));
    }
  });
});

// ------------------------------------------------------------------------------------- events

describe("GET /api/runs/:id/events", () => {
  it("replays the recorded timeline (id = seq) and ends; Last-Event-ID resumes after a seq", async () => {
    const recorded = readTimeline(join(runsDir, realRunId));
    expect(recorded.length).toBeGreaterThan(3);
    const read = async (headers: Record<string, string> = {}) => {
      const res = await app().request(`/api/runs/${realRunId}/events`, { headers });
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const text = await readUntil(res.body!.getReader(), (t) => t.includes("event: end"));
      return frames(text);
    };
    const all = await read();
    const events: TimelineEvent[] = all.filter((f) => f.event === "timeline").map((f) => TimelineEventSchema.parse(JSON.parse(f.data!)));
    expect(events).toEqual(recorded);
    expect(all.filter((f) => f.event === "timeline").map((f) => f.id)).toEqual(recorded.map((e) => String(e.seq)));
    expect(all.at(-1)).toMatchObject({ event: "end" });
    expect(JSON.parse(all.at(-1)!.data!)).toEqual({ runId: realRunId, state: "finished" });

    const resumed = await read({ "Last-Event-ID": "2" });
    expect(resumed.filter((f) => f.event === "timeline").map((f) => Number(f.id))).toEqual(recorded.filter((e) => e.seq > 2).map((e) => e.seq));
  });
});

// ---------------------------------------------------------------------------------- approvals

describe("POST /api/approvals/:id/approve|reject", () => {
  const id = (requestId: string) => approvalIdFor(realRunId, `${realRunId}:${requestId}`);
  const post = async (path: string, body: unknown, env: NodeJS.ProcessEnv = {}, ctx = LOOPBACK, headers = auth()) => {
    const a = app({ approvals: { env, db, manifest, makeTools: (wrap) => w.tools(wrap), decidePolicy: testPolicy.decidePolicy, now: () => new Date(T0) } });
    const res = await a.request(path, { method: "POST", headers, body: JSON.stringify(body) }, ctx);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("needs the token and a loopback socket", async () => {
    expect((await post(`/api/approvals/${id("s1")}/reject`, { reason: "x" }, {}, LOOPBACK, { Host: "localhost:8787", "Content-Type": "application/json" } as never)).status).toBe(401);
    expect((await post(`/api/approvals/${id("s1")}/reject`, { reason: "x" }, {}, REMOTE)).status).toBe(403);
  });

  it("validates the body and the id", async () => {
    expect((await post(`/api/approvals/${id("s1")}/reject`, { reason: "  " })).status).toBe(400);
    expect((await post(`/api/approvals/${id("r1")}/approve`, { confirmedAmount: "2900" }, KEYED_TEST_ENV)).status).toBe(400);
    expect((await post(`/api/approvals/appr-0000000000000000/reject`, { reason: "x" })).status).toBe(404);
    const wrong = await post(`/api/approvals/${id("r1")}/approve`, { confirmedAmount: 29 }, KEYED_TEST_ENV);
    expect(wrong.status).toBe(400);
    expect(String(wrong.json.error)).toMatch(/does not equal the held amount 2900/);
    expect(w.count("createRefund")).toBe(0);
  });

  it("reject by id closes the item keylessly; a second decision is 409", async () => {
    const r = await post(`/api/approvals/${id("s1")}/reject`, { reason: "customer withdrew the request" });
    expect(r.status).toBe(200);
    expect(ApprovalRecordSchema.parse(r.json)).toMatchObject({ id: id("s1"), decision: "rejected", status: "closed", effects: [] });
    expect((await post(`/api/approvals/${id("s1")}/reject`, { reason: "again" })).status).toBe(409);
  });

  it("approve by id executes once in Dodo test mode through the guarded clients", async () => {
    expect((await post(`/api/approvals/${id("r1")}/approve`, { confirmedAmount: 2900 }, { NOTARY_MODE: "test" })).status).toBe(503);
    const r = await post(`/api/approvals/${id("r1")}/approve`, { confirmedAmount: 2900 }, KEYED_TEST_ENV);
    expect(r.status).toBe(200);
    expect(ApprovalRecordSchema.parse(r.json)).toMatchObject({ id: id("r1"), decision: "approved", status: "executed", confirmedAmount: 2900, humanOverride: true });
    expect(w.count("createRefund")).toBe(1);
    expect((await post(`/api/approvals/${id("r1")}/approve`, { confirmedAmount: 2900 }, KEYED_TEST_ENV)).status).toBe(409);
    expect(w.count("createRefund")).toBe(1);
    const l = ApprovalsListSchema.parse(await (await app().request("/api/approvals", { headers: auth() }, LOOPBACK)).json());
    expect(l.pending.map((p) => p.id)).toEqual([id("c1")]);
    expect(JSON.stringify(l)).not.toContain(session.token);
    expect(existsSync(join(runsDir, realRunId, "approvals.json"))).toBe(true);
  });
});
