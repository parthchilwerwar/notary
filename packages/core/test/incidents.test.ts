/**
 * Incidents: deterministic derivation from recorded data, the per-run file, publishing, the live
 * neatlogs log events (real SDK against a local fake collector), the AGENT span helper and the
 * doctor's neatlogs setup report.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSampleBundle, writeBundle } from "../src/bundle/index.js";
import { canonicalJson, sha256Hex } from "../src/bundle/hash.js";
import {
  buildIncidentsFile,
  deriveIncidents,
  incidentId,
  publishIncidents,
  rebuildIncidentsIndex,
  recordRunIncidents,
  reportIncident,
  reportedIncidentIds,
  resetReportedIncidents,
  withIncidentRun,
} from "../src/incidents/index.js";
import type { ApprovalRecord } from "../src/schema/approval.js";
import { IncidentKindSchema, IncidentSchema, IncidentsFileSchema, IncidentsIndexSchema } from "../src/schema/incidents.js";
import type { SpanRecord } from "../src/trace/index.js";
import { initTracing, shutdownTracing, withSpan } from "../src/trace/index.js";
import { withAgent } from "../src/trace/agent.js";
import { neatlogsSetup } from "../src/trace/doctor.js";

const T = "0123456789abcdef0123456789abcdef";
const span = (over: Partial<SpanRecord> & Pick<SpanRecord, "name" | "spanId">): SpanRecord => ({
  traceId: T,
  startedAt: "2026-10-12T00:00:01.000Z",
  endedAt: "2026-10-12T00:00:02.000Z",
  attrs: {},
  status: "ok",
  exported: true,
  ...over,
});

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "notary-incidents-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("deriveIncidents (sample bundle)", () => {
  const bundle = buildSampleBundle();

  it("is deterministic, schema-valid and has unique ids", () => {
    const a = deriveIncidents({ bundle });
    const b = deriveIncidents({ bundle });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    for (const i of a) expect(() => IncidentSchema.parse(i)).not.toThrow();
    expect(new Set(a.map((i) => i.id)).size).toBe(a.length);
    expect(a.every((i) => i.runId === bundle.runId)).toBe(true);
  });

  it("derives each kind from its fact in the records", () => {
    const inc = deriveIncidents({ bundle });
    const kinds = new Set(inc.map((i) => i.kind));
    expect(kinds.has("checker_anomaly")).toBe(bundle.anomalies.length > 0);
    expect(inc.filter((i) => i.kind === "checker_anomaly")).toHaveLength(bundle.anomalies.length);
    expect(inc.filter((i) => i.kind === "guard_hold")).toHaveLength(bundle.decisions.filter((d) => d.status === "held" && d.missingBeliefs.length > 0).length);
    expect(inc.filter((i) => i.kind === "adversary_downgrade")).toHaveLength(
      bundle.beliefs.after.filter((x) => x.adversary && x.adversary.verdict !== "uphold").length,
    );
    expect(inc.filter((i) => i.kind === "belief_unlearned")).toHaveLength(bundle.beliefEvents.filter((e) => e.to === "unlearned").length);
    expect(inc.filter((i) => i.kind === "unsafe_action_executed")).toHaveLength(bundle.decisions.filter((d) => (d.grade?.unsafe ?? []).length > 0).length);
    // Ids are incidentId(kind, subject, runId) — the same function the live reports use.
    const a = bundle.anomalies[0]!;
    expect(inc.find((i) => i.kind === "checker_anomaly" && i.recordIds[0] === a.id)?.id).toBe(incidentId("checker_anomaly", a.id, bundle.runId));
  });

  it("guard holds wait for a person until an approval resolves them", () => {
    const held = bundle.decisions.find((d) => d.status === "held" && d.missingBeliefs.length > 0)!;
    const before = deriveIncidents({ bundle }).find((i) => i.kind === "guard_hold" && i.decisionId === held.id)!;
    expect(before.resolution).toMatchObject({ status: "awaiting_human", action: "held_for_person" });
    const approval: ApprovalRecord = {
      id: "appr-0000000000000001",
      runId: bundle.runId,
      decisionId: held.id,
      requestId: held.requestId,
      action: held.action,
      decision: "rejected",
      reason: "customer withdrew the request",
      humanOverride: true,
      effects: [],
      status: "closed",
      decidedAt: "2026-10-12T01:00:00.000Z",
    };
    const after = deriveIncidents({ bundle, approvals: [approval] }).find((i) => i.id === before.id)!;
    expect(after.resolution).toMatchObject({ status: "resolved", action: "rejected", at: "2026-10-12T01:00:00.000Z", recordIds: [approval.id] });
  });

  it("a precheck that passed is never credited with a refusal: an unknown write outcome is held for a person (audit #2)", () => {
    const g = bundle.guards.find((x) => x.kind === "precheck");
    if (!g) throw new Error("the sample bundle has no precheck guard");
    const base = bundle.decisions.find((d) => d.guardsApplied.includes(g.id)) ?? bundle.decisions[0]!;
    // The precheck ran (so it is listed in guardsApplied) and passed; the refund then timed out.
    const timedOut = { ...base, id: "d-audit-timeout", status: "held" as const, missingBeliefs: [], guardsApplied: [g.id], grade: undefined, error: "write outcome unknown: timeout after 10000 ms" };
    const refused = { ...base, id: "d-audit-refused", status: "held" as const, missingBeliefs: [], guardsApplied: [g.id], grade: undefined, error: `guard ${g.id} refused ${g.operation}: an existing refund covers it` };
    const inc = deriveIncidents({ bundle: { ...bundle, decisions: [timedOut, refused] } });
    const unknown = inc.find((i) => i.decisionId === timedOut.id && i.recordIds.includes(g.id))!;
    expect(unknown).toBeDefined();
    expect(unknown.kind).toBe("tool_error");
    expect(unknown.summary).toMatch(/outcome is unknown/);
    expect(unknown.summary).not.toMatch(/found the write unsafe/);
    expect(unknown.resolution).toMatchObject({ status: "awaiting_human", action: "held_for_person" });
    expect(unknown.resolution.summary).not.toMatch(/No money moved/);
    const stopped = inc.find((i) => i.decisionId === refused.id && i.recordIds.includes(g.id))!;
    expect(stopped.kind).toBe("unsafe_action_prevented");
    expect(stopped.resolution).toMatchObject({ status: "resolved", action: "action_refused" });
  });

  it("ids include the run id: the same anomaly in two runs is two incidents (audit #4)", () => {
    const a = deriveIncidents({ bundle });
    const b = deriveIncidents({ bundle: { ...bundle, runId: `${bundle.runId}-second` } });
    const anomaly = bundle.anomalies[0]!;
    const idA = a.find((i) => i.recordIds[0] === anomaly.id)!.id;
    const idB = b.find((i) => i.recordIds[0] === anomaly.id)!.id;
    expect(idA).not.toBe(idB);
    expect(idA).toBe(incidentId("checker_anomaly", anomaly.id, bundle.runId));
    expect(incidentId("checker_anomaly", anomaly.id, "run-a")).not.toBe(incidentId("checker_anomaly", anomaly.id, "run-b"));
  });

  it("only the run in which an event happened gets its incident; a replay output derives none (data audit A)", () => {
    const reviewed = bundle.beliefs.after.find((x) => x.adversary && x.adversary.verdict !== "uphold");
    if (!reviewed) throw new Error("the sample bundle has no adversary downgrade/narrow");
    const own = deriveIncidents({ bundle }).filter((i) => i.kind === "adversary_downgrade");
    expect(own.length).toBeGreaterThan(0);
    // A later run that carries the same beliefs from the store (reviewed before it started): not its incidents.
    const later = { ...bundle, runId: "later-run", startedAt: "2030-01-01T00:00:00.000Z", finishedAt: "2030-01-01T00:10:00.000Z" };
    const carried = deriveIncidents({ bundle: later });
    expect(carried.filter((i) => i.kind === "adversary_downgrade")).toEqual([]);
    expect(carried.filter((i) => i.kind === "probe_contradiction")).toEqual([]);
    expect(carried.filter((i) => i.kind === "belief_unlearned")).toEqual([]);
    // Its own records (anomalies, decisions) still count.
    expect(carried.filter((i) => i.kind === "checker_anomaly")).toHaveLength(bundle.anomalies.length);
    // A replay output re-serves the original run: no incidents of its own.
    expect(deriveIncidents({ bundle: { ...bundle, runId: `${bundle.runId}-replay`, mode: "replay", replayOf: bundle.runId } })).toEqual([]);
  });

  it("links a trace only when it was exported and a real template exists", () => {
    const withTrace = { ...bundle, anomalies: bundle.anomalies.map((a, i) => (i === 0 ? { ...a, traceId: T, spanId: "0123456789abcdef" } : a)) };
    const tpl = (id: string) => `https://app.example.test/t/${id}`;
    const local = deriveIncidents({ bundle: withTrace, spans: [span({ name: "x", spanId: "0123456789abcdef", exported: undefined })], traceUrlFor: tpl });
    const first = local.find((i) => i.recordIds[0] === bundle.anomalies[0]!.id)!;
    expect(first).toMatchObject({ traceId: T, spanId: "0123456789abcdef", exported: false });
    expect(first.traceUrl).toBeUndefined();
    const exported = deriveIncidents({ bundle: withTrace, spans: [span({ name: "x", spanId: "0123456789abcdef" })], traceUrlFor: tpl });
    expect(exported.find((i) => i.id === first.id)).toMatchObject({ exported: true, traceUrl: `https://app.example.test/t/${T}` });
    expect(deriveIncidents({ bundle: withTrace, spans: [span({ name: "x", spanId: "0123456789abcdef" })] }).find((i) => i.id === first.id)?.traceUrl).toBeUndefined();
  });
});

describe("deriveIncidents (span log)", () => {
  const bundle = { ...buildSampleBundle(), anomalies: [], probes: [], beliefEvents: [], decisions: [], beliefs: { before: [], after: [] } };

  it("429 retries, model errors, USD-cap stops and tool failures", () => {
    const spans: SpanRecord[] = [
      span({ name: "notary.agent.reflector", spanId: "a000000000000001", attrs: { "notary.agent_id": "reflector" } }),
      span({ name: "notary.llm", spanId: "a000000000000002", parentSpanId: "a000000000000001", attrs: { "notary.agent": "Reflector", "llm.model_id": "m", "llm.attempts": 2, "llm.retry_after_ms": 1500 } }),
      span({ name: "notary.llm", spanId: "a000000000000003", parentSpanId: "a000000000000001", status: "error", error: "Error: upstream 500", attrs: { "llm.model_id": "m" } }),
      span({ name: "notary.llm", spanId: "a000000000000004", status: "error", error: "UsdCapExceededError: cap", attrs: { "notary.agent": "Adversary", "llm.model_id": "m" } }),
      span({ name: "notary.tool.call", spanId: "a000000000000005", startedAt: "2026-10-12T00:00:03.000Z", attrs: { "notary.tool": "crustdata", "notary.tool.op": "crustdata.enrichCompany", "http.status_code": 429 } }),
      span({ name: "notary.tool.call", spanId: "a000000000000006", startedAt: "2026-10-12T00:00:09.000Z", attrs: { "notary.tool": "crustdata", "notary.tool.op": "crustdata.enrichCompany", "http.status_code": 200 } }),
      span({ name: "notary.probe", spanId: "a000000000000007" }),
      span({ name: "notary.tool.call", spanId: "a000000000000008", parentSpanId: "a000000000000007", status: "error", error: "ToolNetworkError: reset", attrs: { "notary.tool": "dodo", "notary.tool.op": "dodo.getPayment" } }),
    ];
    const inc = deriveIncidents({ bundle, spans });
    const by = (spanId: string) => inc.find((i) => i.spanId === spanId);
    expect(by("a000000000000002")).toMatchObject({ kind: "rate_limited", agent: "reflector", resolution: { status: "resolved", action: "retried" } });
    expect(by("a000000000000003")).toMatchObject({ kind: "model_error", severity: "error", agent: "reflector", resolution: { status: "resolved", action: "failed_safe" } });
    expect(by("a000000000000004")).toMatchObject({ kind: "budget_stop", agent: "adversary", resolution: { action: "run_stopped" } });
    expect(by("a000000000000005")).toMatchObject({ kind: "rate_limited", tool: "crustdata", resolution: { status: "resolved", recordIds: ["a000000000000006"] } });
    expect(by("a000000000000008")).toMatchObject({ kind: "tool_error", tool: "dodo", resolution: { status: "resolved", action: "failed_safe" } });
    expect(by("a000000000000006")).toBeUndefined();
    expect(inc.every((i) => i.exported)).toBe(true);
    expect(by("a000000000000002")!.id).toBe(incidentId("rate_limited", "a000000000000002", bundle.runId));
  });

  it("covers every kind in the schema with a rule (no orphan kinds)", () => {
    // Every kind appears in derive.ts; this guards against adding a kind without a rule.
    const src = readFileSync(new URL("../src/incidents/derive.ts", import.meta.url), "utf8");
    for (const k of IncidentKindSchema.options) expect(src.includes(`"${k}"`), k).toBe(true);
  });
});

describe("incident files", () => {
  it("records runs/<runId>/incidents.json, publishes it and rebuilds the index", async () => {
    const bundle = buildSampleBundle();
    const runDir = join(root, "runs", bundle.runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "spans.jsonl"),
      `${JSON.stringify(span({ name: "notary.llm", spanId: "b000000000000001", attrs: { "llm.attempts": 3, "notary.agent_id": "executor" } }))}\nnot json\n`,
    );
    const rec = await recordRunIncidents(bundle, runDir, { emit: false });
    expect(rec.error).toBeUndefined();
    const onDisk = IncidentsFileSchema.parse(JSON.parse(readFileSync(join(runDir, "incidents.json"), "utf8")));
    expect(onDisk).toEqual(rec.file);
    expect(onDisk.sources).toEqual(["bundle", "spans"]);
    expect(onDisk.bundleHash).toBe(bundle.contentHash);
    expect(onDisk.incidents.some((i) => i.kind === "rate_limited")).toBe(true);
    expect(buildIncidentsFile(bundle, { runDir })).toEqual(onDisk);

    const web = join(root, "web", "bundles");
    const incDir = join(root, "web", "incidents");
    await expect(publishIncidents(bundle, incDir, { expectSample: false, runDir })).rejects.toThrow(/fixture and real data never mix/);
    await writeBundle(bundle, web);
    const pub = await publishIncidents(bundle, incDir, { expectSample: true, runDir });
    expect(pub.path).toBe(join(incDir, `${bundle.runId}.json`));
    expect(existsSync(pub.path)).toBe(true);
    const idx = await rebuildIncidentsIndex(incDir, { sample: true, bundlesDir: web });
    expect(idx.path).toBe(join(incDir, "index.json"));
    expect(idx).toMatchObject({ runs: 1, incidents: onDisk.incidents.length });
    const index = IncidentsIndexSchema.parse(JSON.parse(readFileSync(idx.path, "utf8")));
    expect(index.runs.map((r) => r.runId)).toEqual([bundle.runId]);
    // The index carries its own content hash, recomputable like a bundle's (the browser checks it).
    const raw = JSON.parse(readFileSync(idx.path, "utf8")) as Record<string, unknown>;
    const { contentHash, ...rest } = raw;
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(canonicalJson(rest))).toBe(contentHash);
    // A real-world index never picks up sample files.
    expect((await rebuildIncidentsIndex(join(root, "web", "incidents-real"), { sample: false, bundlesDir: web })).runs).toBe(0);
    // Nothing incident-shaped is ever written into the bundles directory.
    expect(readdirSync(web).filter((f) => f.includes("incident"))).toEqual([]);
  });
});

describe("live incident reports with tracing off", () => {
  it("returns the deterministic id and records nothing as sent", async () => {
    resetReportedIncidents();
    await shutdownTracing();
    const id = reportIncident({ kind: "probe_contradiction", subject: "p-1", severity: "warning", summary: "x" });
    expect(id).toBe(incidentId("probe_contradiction", "p-1"));
    expect(reportedIncidentIds().has(id)).toBe(false);
  });
});

describe("neatlogs setup report (doctor)", () => {
  it("reports versions and flags, never values", async () => {
    const secret = "nl-super-secret-value-123456";
    const on = await neatlogsSetup({ NEATLOGS_API_KEY: secret, NEATLOGS_SERVICE_TOKEN: "svc-token-abcdefgh" } as NodeJS.ProcessEnv);
    expect(on).toMatchObject({ export: "on", serviceToken: "set" });
    expect(on.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.stringify(on)).not.toContain(secret);
    expect(JSON.stringify(on)).not.toContain("svc-token-abcdefgh");
    const off = await neatlogsSetup({ NEATLOGS_API_KEY: secret, NEATLOGS_DISABLE_EXPORT: "true" } as NodeJS.ProcessEnv);
    expect(off).toMatchObject({ export: "off", exportReason: "NEATLOGS_DISABLE_EXPORT is set", serviceToken: "not set" });
    expect(off.readBackHint).toMatch(/NEATLOGS_TOKEN/);
  });
});

/** The real SDK exporting to a local fake collector: incident logs and AGENT spans leave the process. */
describe("with the neatlogs SDK on (local fake collector)", () => {
  const ENV_KEYS = ["NEATLOGS_API_KEY", "NEATLOGS_ENDPOINT", "NEATLOGS_LOG_SPANS", "NEATLOGS_LOG_SPANS_FILE", "NEATLOGS_DISABLE_EXPORT"] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const logs: Buffer[] = [];
  let collector: Server;
  let logFile: string;
  let enabled = false;

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    await shutdownTracing();
    collector = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "POST" && (req.url ?? "").startsWith("/v1/logs")) {
          const raw = Buffer.concat(chunks);
          try {
            logs.push(req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw);
          } catch {
            logs.push(raw);
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
    mkdirSync(join(root, "sdk"), { recursive: true });
    process.env.NEATLOGS_API_KEY = "nl-fake-test-key-not-real-0002";
    process.env.NEATLOGS_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.NEATLOGS_LOG_SPANS = "true";
    process.env.NEATLOGS_LOG_SPANS_FILE = logFile;
    delete process.env.NEATLOGS_DISABLE_EXPORT;
    enabled = (await initTracing({ serviceName: "incidents-test" })).enabled;
    resetReportedIncidents();
  }, 60_000);

  afterAll(async () => {
    await shutdownTracing();
    collector.closeAllConnections();
    await new Promise<void>((r) => collector.close(() => r()));
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("an incident is a warn log on the active span; an agent run is an AGENT span", { timeout: 30_000 }, async () => {
    expect(enabled).toBe(true);
    let id = "";
    await withAgent("reflector", { "notary.claimId": "c-1" }, () =>
      withSpan("notary.probe", { "notary.probeId": "p-live-1" }, () => {
        id = reportIncident({ kind: "probe_contradiction", subject: "p-live-1", severity: "warning", summary: "Probe p-live-1 contradicted the docs." });
        return "ok";
      }, { kind: "TOOL" }),
    );
    expect(reportedIncidentIds().has(id)).toBe(true);
    // Audit #4: in one process (`notary serve`), a second run's identical incident is reported too.
    const inRunA = withIncidentRun("run-a", () => reportIncident({ kind: "checker_anomaly", subject: "a-same", severity: "warning", summary: "same anomaly, run a" }));
    const inRunB = withIncidentRun("run-b", () => reportIncident({ kind: "checker_anomaly", subject: "a-same", severity: "warning", summary: "same anomaly, run b" }));
    expect(inRunA).toBe(incidentId("checker_anomaly", "a-same", "run-a"));
    expect(inRunB).toBe(incidentId("checker_anomaly", "a-same", "run-b"));
    expect(inRunA).not.toBe(inRunB);
    expect(reportedIncidentIds("run-a").has(inRunA)).toBe(true);
    expect(reportedIncidentIds("run-b").has(inRunB)).toBe(true);
    await shutdownTracing(); // flushes logs + closes the SDK span log
    const all = Buffer.concat(logs).toString("latin1");
    expect(all).toContain(id);
    expect(all).toContain(inRunB);
    expect(all).toContain("notary.incident.kind");
    expect(all).toContain("probe_contradiction");
    const spans = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { name: string; kind: string; attributes: Record<string, unknown> });
    const agent = spans.find((s) => s.name === "notary.agent.reflector");
    expect(agent).toBeDefined();
    expect(agent!.kind).toBe("agent");
    expect(agent!.attributes["notary.agent_id"]).toBe("reflector");
  });
});

describe("readBackTrace (GET /api/traces/v3/<traceId> with the project key)", () => {
  const env = { NEATLOGS_API_KEY: "nl-readback-key-0123456789" } as NodeJS.ProcessEnv;
  it("returns counts only and sends the key as x-api-key to the ingest origin", async () => {
    const { readBackTrace } = await import("../src/trace/readback.js");
    let seen: { url: string; key: string | null } | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, key: new Headers(init?.headers).get("x-api-key") };
      return new Response(JSON.stringify({ name: "notarize.crustdata", spanCount: 3, llmCalls: 1, toolCalls: 1, status: "success", detections: [], spans: [{ node_type: "log", node_name: "incident checker_anomaly [WARN]: x" }, { node_type: "log", node_name: "notary.probe.committed" }, { node_type: "llm" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await readBackTrace(T, { env, fetchImpl });
    expect(seen).toEqual({ url: `https://ingest.neatlogs.com/api/traces/v3/${T}`, key: env.NEATLOGS_API_KEY });
    expect(r).toEqual({ status: "ok", traceId: T, name: "notarize.crustdata", spanCount: 3, llmCalls: 1, toolCalls: 1, logs: 2, incidentLogs: 1, traceStatus: "success", detections: 0 });
    expect(JSON.stringify(r)).not.toContain(env.NEATLOGS_API_KEY!);
  });
  it("404 is not_found, 403 auth_failed, no key skipped", async () => {
    const { readBackTrace } = await import("../src/trace/readback.js");
    const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
    expect((await readBackTrace(T, { env, fetchImpl: status(404) })).status).toBe("not_found");
    expect((await readBackTrace(T, { env, fetchImpl: status(403) })).status).toBe("auth_failed");
    expect((await readBackTrace(T, { env: {} as NodeJS.ProcessEnv })).status).toBe("skipped");
  });
});
