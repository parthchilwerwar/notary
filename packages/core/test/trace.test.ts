import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  flushTracing,
  initTracing,
  traceBedrockClient,
  traceLog,
  tracingEnabled,
  withSpan,
  withWorkflow,
} from "../src/trace/index.js";
import { runDoctor } from "../src/trace/doctor.js";

describe("tracing with NEATLOGS_API_KEY unset", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.NEATLOGS_API_KEY;
    delete process.env.NEATLOGS_API_KEY;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.NEATLOGS_API_KEY;
    else process.env.NEATLOGS_API_KEY = saved;
  });

  it("initTracing reports disabled with a reason", async () => {
    const state = await initTracing({ runId: "run-test" });
    expect(state).toEqual({ enabled: false, reason: "NEATLOGS_API_KEY not set" });
    expect(tracingEnabled()).toBe(false);
  });

  it("treats a blank key as unset", async () => {
    process.env.NEATLOGS_API_KEY = "   ";
    const state = await initTracing();
    expect(state.enabled).toBe(false);
  });

  it("withSpan runs fn and returns its value (sync and async)", async () => {
    await initTracing();
    const attrs = { "notary.runId": "r1", "notary.probeId": "p1", "notary.prediction": "200" };
    expect(await withSpan("sync", attrs, () => 42)).toBe(42);
    expect(await withSpan("async", attrs, async () => "done")).toBe("done");
  });

  it("withSpan propagates errors from fn unchanged", async () => {
    await initTracing();
    const boom = new Error("boom");
    await expect(withSpan("fails", {}, () => { throw boom; })).rejects.toBe(boom);
    await expect(withSpan("fails-async", {}, async () => { throw boom; })).rejects.toBe(boom);
  });

  it("traceLog and flushTracing are no-ops", async () => {
    expect(() => traceLog("hello {x}", { x: 1 })).not.toThrow();
    await expect(flushTracing()).resolves.toBeUndefined();
  });

  it("runDoctor reports spanEmitted:false without throwing", async () => {
    const report = await runDoctor();
    expect(report.tracing.enabled).toBe(false);
    expect(report.spanEmitted).toBe(false);
    expect(report.spanId).toBeUndefined();
    expect(report.traceId).toBeUndefined();
    expect(report.notes.join(" ")).toContain("NEATLOGS_API_KEY not set");
  });
});

describe("entry-point helpers with tracing off", () => {
  it("withWorkflow passes the result and errors through", async () => {
    expect(await withWorkflow("test.workflow", async () => 42)).toBe(42);
    await expect(withWorkflow("test.workflow", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("traceBedrockClient returns the same client", () => {
    const client = { send: async () => ({}) };
    expect(traceBedrockClient(client)).toBe(client);
  });
});
