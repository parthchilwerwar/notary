// Real data for the rendered scenes of the submission video, written to explainer/data/:
//   traces.json            the two notarize traces read back from neatlogs (GET <ingest>/api/traces/v3/<id>, project key),
//                          safe attributes only; per span, `source` says where each field came from
//   entire.json            copy of packages/web/public/evidence/entire.json
//   economics.json         copy of packages/web/public/economics.json
//   incidents-*.json       copies of the two runs' incident files
//   eval-suite.json        naive vs guarded stats from the published fixture bundles (hash-verified)
//   coverage.txt           only with --coverage: stdout of `pnpm notary guards coverage --backend entire` (~1 min)
//
//   pnpm --filter @notary/showreel explainer-data [--coverage]
//
// Never writes prompts, model outputs or keys. When neatlogs can't return a trace, the trace falls back to the
// local receipts (packages/core/runs/<runId>/spans.jsonl) and is marked source: "local receipts".
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeContentHash } from "../../core/src/bundle/hash.ts";
import { RunBundleSchema, type RunBundle } from "../../core/src/schema/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const REPO = resolve(ROOT, "../..");
const PUBLIC = resolve(REPO, "packages/web/public");
const OUT = resolve(ROOT, "explainer/data");

const RUNS = [
  { runId: "notarize-crustdata-20261012T011404Z", incidentsOut: "incidents-crustdata.json", traceId: "9db41ecd43406cef291c93ef8c9ab1cd" },
  { runId: "notarize-dodo-20261012T012315Z", incidentsOut: "incidents-dodo.json", traceId: null as string | null },
];

/** Attributes that may appear in the film: ids, hashes, verdicts, models, counts. Nothing else. */
const SAFE_ATTRS = new Set([
  "notary.agent", "notary.role", "notary.probeId", "notary.claimId", "notary.beliefId", "notary.template",
  "notary.prediction", "notary.predictionHash", "notary.committedAt", "notary.verdict", "notary.winningHypothesisId",
  "notary.adversary.backend", "notary.adversary.probes", "notary.tool", "notary.op", "notary.guard.decision",
  "http.status_code", "http.response.status_code", "llm.model_id", "llm.input_tokens", "llm.output_tokens", "llm.usd",
  "model", "tool_name", "log_level",
]);
const pick = (o: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => SAFE_ATTRS.has(k) && v !== "" && v !== null && v !== undefined));

type ReceiptSpan = { name: string; kind: string; traceId: string; spanId: string; parentSpanId?: string; startedAt: string; endedAt: string; attrs?: Record<string, unknown>; status: string };
type ApiSpan = {
  span_id: string; parent_span_id?: string; node_name: string; node_type: string; status: string; createdAt: string; updatedAt: string;
  data?: { duration_ms?: number; llm_model?: string; error_message?: string };
  span_metadata?: { log_data?: Record<string, unknown>; log_level?: string; model?: string; tool_name?: string; token_usage?: { input?: number; output?: number } } | null;
};
type ApiTrace = { _id: string; name: string; createdAt: string; latency: number; spanCount: number; llmCalls: number; toolCalls: number; status: string; hasError: number; errorCount: number; detections?: unknown[]; spans: ApiSpan[] };

function receipts(runId: string): ReceiptSpan[] {
  const p = resolve(REPO, "packages/core/runs", runId, "spans.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ReceiptSpan);
}

async function fetchTrace(traceId: string, key: string): Promise<{ ok: true; trace: ApiTrace } | { ok: false; detail: string }> {
  const origin = new URL((process.env.NEATLOGS_ENDPOINT ?? "").trim() || "https://ingest.neatlogs.com").origin;
  try {
    const res = await fetch(`${origin}/api/traces/v3/${traceId}`, { headers: { "x-api-key": key }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).split(key).join("[REDACTED]").slice(0, 200)}` };
    return { ok: true, trace: (await res.json()) as ApiTrace };
  } catch (err) {
    return { ok: false, detail: (err instanceof Error ? err.message : String(err)).split(key).join("[REDACTED]").slice(0, 200) };
  }
}

async function traces() {
  const key = (process.env.NEATLOGS_API_KEY ?? "").trim();
  const out = [];
  for (const run of RUNS) {
    const local = receipts(run.runId);
    const incidents = JSON.parse(readFileSync(resolve(PUBLIC, "incidents", `${run.runId}.json`), "utf8")) as { incidents: { traceId?: string }[] };
    const traceId = run.traceId ?? incidents.incidents.find((i) => i.traceId)?.traceId ?? local[0]?.traceId;
    if (!traceId) throw new Error(`${run.runId}: no trace id in its incidents or receipts`);
    const byId = new Map(local.filter((s) => s.traceId === traceId).map((s) => [s.spanId, s]));
    const got = key ? await fetchTrace(traceId, key) : ({ ok: false, detail: "NEATLOGS_API_KEY not set" } as const);
    if (got.ok) {
      const t = got.trace;
      const t0 = Date.parse(t.createdAt);
      const spans = t.spans
        .map((s) => {
          const r = byId.get(s.span_id);
          const startMs = Date.parse(s.createdAt) - t0;
          const meta = s.span_metadata ?? {};
          const apiAttrs = {
            ...pick(meta.log_data),
            ...pick({ log_level: meta.log_level, model: meta.model, tool_name: meta.tool_name }),
            ...(meta.token_usage ? { "llm.input_tokens": meta.token_usage.input, "llm.output_tokens": meta.token_usage.output } : {}),
          };
          return {
            spanId: s.span_id,
            parentId: s.parent_span_id || null,
            name: s.node_name,
            kind: s.node_type,
            startMs,
            endMs: startMs + Math.round(s.data?.duration_ms ?? 0),
            status: s.status,
            ...(s.data?.error_message ? { error: s.data.error_message.slice(0, 200) } : {}),
            attributes: apiAttrs,
            ...(r
              ? {
                  receipt: {
                    source: "local receipts",
                    startedAt: r.startedAt,
                    endedAt: r.endedAt,
                    kind: r.kind,
                    parentId: r.parentSpanId ?? null,
                    attributes: pick(r.attrs),
                  },
                }
              : {}),
          };
        })
        .sort((a, b) => a.startMs - b.startMs || (a.receipt?.startedAt ?? "").localeCompare(b.receipt?.startedAt ?? ""));
      const apiIds = new Set(t.spans.map((s) => s.span_id));
      const missing = [...byId.values()].filter((s) => !apiIds.has(s.spanId));
      out.push({
        id: traceId,
        runId: run.runId,
        source: "neatlogs API",
        endpoint: "GET https://ingest.neatlogs.com/api/traces/v3/<traceId> (project key)",
        rootName: t.name,
        startedAt: t.createdAt,
        endedAt: new Date(t0 + t.latency).toISOString(),
        spanCount: t.spanCount,
        llmCalls: t.llmCalls,
        toolCalls: t.toolCalls,
        status: t.status,
        hasError: t.hasError,
        errorCount: t.errorCount,
        detections: Array.isArray(t.detections) ? t.detections.length : 0,
        note:
          "Span times come from neatlogs (start rounded to the second, durations exact). neatlogs stores notary.* span attributes only for log records (notary.probe.committed); `receipt` adds the same span's record from the run's local receipts (spans.jsonl) where the span ids match.",
        spans,
        ...(missing.length
          ? {
              inReceiptsNotInApi: missing.map((r) => ({
                source: "local receipts",
                spanId: r.spanId,
                parentId: r.parentSpanId ?? null,
                name: r.name,
                kind: r.kind,
                startedAt: r.startedAt,
                endedAt: r.endedAt,
                status: r.status,
                attributes: pick(r.attrs),
              })),
            }
          : {}),
      });
      console.log(`${traceId}: neatlogs API, ${t.spans.length} spans (${missing.length} receipt span(s) not in the API response)`);
    } else {
      const spans = [...byId.values()].map((r) => ({
        spanId: r.spanId,
        parentId: r.parentSpanId ?? null,
        name: r.name,
        kind: r.kind,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        status: r.status,
        attributes: pick(r.attrs),
      }));
      out.push({ id: traceId, runId: run.runId, source: "local receipts", apiError: got.detail, spanCount: spans.length, spans });
      console.log(`${traceId}: neatlogs API failed (${got.detail}); ${spans.length} spans from local receipts`);
    }
  }
  return { generatedAt: new Date().toISOString(), traces: out };
}

function evalSuite() {
  const load = (runId: string) => {
    const b: RunBundle = RunBundleSchema.parse(JSON.parse(readFileSync(resolve(PUBLIC, "bundles/fixture", `${runId}.json`), "utf8")));
    const recomputed = computeContentHash(b);
    if (recomputed !== b.contentHash) throw new Error(`${runId}: content hash mismatch (${recomputed} vs ${b.contentHash})`);
    return b;
  };
  const naive = load("demo-run-naive");
  const guarded = load("demo-run-guarded");
  const isRefund = (t: string) => t.includes("refund");
  const stats = (b: RunBundle) => ({
    runId: b.runId,
    variant: b.variant,
    contentHash: b.contentHash,
    sample: b.sample,
    queueSize: b.metrics.items_total,
    unsafe: b.metrics.unsafe_actions_total,
    executed: b.metrics.executed,
    held: b.decisions.filter((d) => d.status === "held").length,
    refundsHeld: b.decisions.filter((d) => d.status === "held" && isRefund(d.requestType)).length,
  });
  return {
    label: "Evaluation suite — simulated APIs, not a live run",
    source: "packages/web/public/bundles/fixture/demo-run-{naive,guarded}.json (content hashes recomputed)",
    disclosure: guarded.disclosure,
    naive: stats(naive),
    guarded: stats(guarded),
  };
}

async function main() {
  if (existsSync(resolve(REPO, ".env"))) process.loadEnvFile(resolve(REPO, ".env"));
  await mkdir(OUT, { recursive: true });
  await copyFile(resolve(PUBLIC, "evidence/entire.json"), resolve(OUT, "entire.json"));
  await copyFile(resolve(PUBLIC, "economics.json"), resolve(OUT, "economics.json"));
  for (const r of RUNS) await copyFile(resolve(PUBLIC, "incidents", `${r.runId}.json`), resolve(OUT, r.incidentsOut));
  const ev = evalSuite();
  await writeFile(resolve(OUT, "eval-suite.json"), JSON.stringify(ev, null, 2) + "\n");
  console.log(`eval-suite: naive unsafe ${ev.naive.unsafe}, guarded unsafe ${ev.guarded.unsafe}, refunds held ${ev.guarded.refundsHeld}`);
  await writeFile(resolve(OUT, "traces.json"), JSON.stringify(await traces(), null, 2) + "\n");
  if (process.argv.includes("--coverage")) {
    const stdout = execFileSync("pnpm", ["-s", "notary", "guards", "coverage", "--backend", "entire"], { cwd: REPO, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 16 << 20 });
    await writeFile(resolve(OUT, "coverage.txt"), stdout);
    console.log(`coverage.txt: ${stdout.trim().split("\n").pop()}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
