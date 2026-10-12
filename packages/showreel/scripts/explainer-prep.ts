// Gathers everything the Explainer composition shows into src/explainer/assets.json, and mirrors the
// media it plays into public/explainer/ (Remotion serves only public/). Run it whenever files land in
// explainer/; with --watch it polls the folder and regenerates on any change, so the composition
// swaps each placeholder for the real file as soon as it arrives.
//
//   explainer/voice/<section>.mp3 + .json   voice agent  → real voice + word timings (else: placeholder
//                                                          timings estimated from docs/video/NARRATION.md, no audio)
//   explainer/clips/<clip>.mp4 + .json      recording agent → real clip + interaction log (else: the scene
//                                                          renders the same records from data instead)
//   explainer/user/neatlogs-incidents.mp4   optional lead shot of the neatlogs section
//   explainer/data/*                        real artifacts; each falls back to the published records
//                                           (packages/web/public) or the local run receipts (packages/core/runs)
//
// Nothing is typed in: a value that cannot be read from a file is left out, never invented.
//
//   pnpm --filter @notary/showreel explainer:prep [--watch]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remotionBinary } from "./lib";
import { AssetsSchema, SECTION_IDS, type Assets, type Incident, type Span, type Trace, type Word } from "../src/explainer/schema";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const REPO = resolve(ROOT, "../..");
const EXPL = join(ROOT, "explainer");
const PUB = join(ROOT, "public/explainer");
const WEB_PUBLIC = join(REPO, "packages/web/public");
const RUNS = join(REPO, "packages/core/runs");
const OUT_JSON = join(ROOT, "src/explainer/assets.json");

const CLIP_IDS = ["crustdata-anomalies", "transcript-prediction", "certificate-adversary", "certificates-grid", "approvals-held", "incidents-resolution", "economics"] as const;
const TRACE_RUNS = [
  { traceId: "9db41ecd43406cef291c93ef8c9ab1cd", runId: "notarize-crustdata-20261012T011404Z" },
  { traceId: "a0e6fda50d71a9eb2fec0f04843bff4d", runId: "notarize-dodo-20261012T012315Z" },
] as const;
const EVAL_LABEL = "Evaluation suite — simulated APIs, not a live run";

const rel = (p: string) => p.slice(REPO.length + 1).replaceAll("\\", "/");
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
const firstExisting = (...ps: string[]) => ps.find((p) => existsSync(p)) ?? null;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

// ------------------------------------------------------------------------------- media

function probe(file: string): { durationSec: number; width: number; height: number } {
  const out = execFileSync(remotionBinary("ffprobe"), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  return { durationSec: Number(j.format?.duration ?? 0), width: v?.width ?? 0, height: v?.height ?? 0 };
}

/** Mirror a file into public/explainer (only when it changed); returns its path under public/. */
function mirror(src: string, sub: string): string {
  const dest = join(PUB, sub, basename(src));
  mkdirSync(dirname(dest), { recursive: true });
  const a = statSync(src);
  const b = existsSync(dest) ? statSync(dest) : null;
  if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) copyFileSync(src, dest);
  // Clips get a second copy for the focus lens, so its frames come from their own decoder (two
  // simultaneous extractions from one source made Remotion's compositor miss frames).
  if (sub === "clips") {
    const lens = dest.replace(/.mp4$/, ".lens.mp4");
    const c = existsSync(lens) ? statSync(lens) : null;
    if (!c || c.size !== a.size || c.mtimeMs < a.mtimeMs) copyFileSync(src, lens);
  }
  return `explainer/${sub}/${basename(src)}`;
}

// ------------------------------------------------------------------------------- narration + voice

function narration(): Record<string, string> {
  const md = readFileSync(join(REPO, "docs/video/NARRATION.md"), "utf8");
  const out: Record<string, string> = {};
  const parts = md.split(/^## /m).slice(1);
  for (const p of parts) {
    const [head, ...body] = p.split(/\r?\n/);
    const id = head!.trim();
    if ((SECTION_IDS as readonly string[]).includes(id)) out[id] = body.join(" ").replace(/\s+/g, " ").trim();
  }
  for (const id of SECTION_IDS) if (!out[id]) throw new Error(`NARRATION.md has no section "${id}"`);
  return out;
}

/** Placeholder timings: ~2.5 words/s with short pauses at punctuation. Marked placeholder on screen. */
function estimateWords(text: string): { words: Word[]; durationSec: number } {
  const words: Word[] = [];
  let t = 0;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const len = 0.22 + Math.min(0.4, w.replace(/[^\p{L}\p{N}]/gu, "").length * 0.035);
    words.push({ text: w, startSec: +t.toFixed(3), endSec: +(t + len).toFixed(3) });
    t += len + 0.06 + (/[.:!?]$/.test(w) ? 0.38 : /[,;]$/.test(w) ? 0.16 : 0);
  }
  return { words, durationSec: +(t + 0.1).toFixed(3) };
}

function voices(text: Record<string, string>): Assets["voice"] {
  const out: Assets["voice"] = {};
  for (const id of SECTION_IDS) {
    const mp3 = join(EXPL, "voice", `${id}.mp3`);
    const json = join(EXPL, "voice", `${id}.json`);
    if (existsSync(mp3) && existsSync(json)) {
      const j = readJson(json) as Obj;
      const words = (Array.isArray(j.words) ? j.words : []).flatMap((w): Word[] => {
        if (!isObj(w)) return [];
        const t = str(w.text ?? w.word);
        const s = num(w.startSec ?? w.start);
        const e = num(w.endSec ?? w.end);
        return t && s !== null && e !== null && t.trim() ? [{ text: t.trim(), startSec: s, endSec: e }] : [];
      });
      const dur = num(j.durationSec) ?? probe(mp3).durationSec;
      if (words.length) {
        out[id] = { status: "real", src: mirror(mp3, "voice"), durationSec: dur, words };
        if (str(j.text)) text[id] = str(j.text)!;
        continue;
      }
      console.warn(`voice/${id}.json has no usable words: using the placeholder`);
    }
    const est = estimateWords(text[id]!);
    out[id] = { status: "placeholder", src: null, durationSec: est.durationSec, words: est.words };
  }
  return out;
}

// ------------------------------------------------------------------------------- clips

function clips(): Assets["clips"] {
  const out: Assets["clips"] = {};
  const ids = new Set<string>(CLIP_IDS);
  if (existsSync(join(EXPL, "clips"))) for (const f of readdirSync(join(EXPL, "clips"))) if (f.endsWith(".mp4")) ids.add(f.slice(0, -4));
  for (const id of ids) {
    const mp4 = join(EXPL, "clips", `${id}.mp4`);
    const json = join(EXPL, "clips", `${id}.json`);
    if (!existsSync(mp4)) {
      out[id] = { status: "missing", src: null, durationSec: 0, width: 1920, height: 1080, url: null, events: [] };
      continue;
    }
    const m = probe(mp4);
    const j = existsSync(json) ? (readJson(json) as Obj) : {};
    const events = (Array.isArray(j.events) ? j.events : []).flatMap((e) => {
      if (!isObj(e)) return [];
      const t = num(e.tSec ?? e.t), x = num(e.x), y = num(e.y);
      const type = str(e.type);
      if (t === null || x === null || y === null || !type || !["move", "click", "scroll", "type"].includes(type)) return [];
      return [{ tSec: t, type: type as "move", x, y, ...(str(e.label) ? { label: str(e.label)! } : {}) }];
    });
    out[id] = { status: "real", src: mirror(mp4, "clips"), durationSec: m.durationSec, width: m.width || 1920, height: m.height || 1080, url: str(j.url), events: events.sort((a, b) => a.tSec - b.tSec) };
  }
  return out;
}

// ------------------------------------------------------------------------------- traces

const toMs = (v: unknown): number | null => {
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== "") return toMs(n);
    const t = Date.parse(v.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "number") return v > 1e17 ? v / 1e6 : v > 1e14 ? v / 1e3 : v > 1e11 ? v : v * 1000;
  return null;
};

function flatAttrs(a: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (Array.isArray(a)) {
    // OTLP: [{ key, value: { stringValue | intValue | doubleValue | boolValue } }]
    for (const kv of a) {
      if (!isObj(kv) || typeof kv.key !== "string") continue;
      const v = isObj(kv.value) ? (kv.value.stringValue ?? kv.value.intValue ?? kv.value.doubleValue ?? kv.value.boolValue) : kv.value;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[kv.key] = v;
    }
  } else if (isObj(a)) {
    const walk = (o: Obj, prefix: string) => {
      for (const [k, v] of Object.entries(o)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v;
        else if (isObj(v)) walk(v, key);
      }
    };
    walk(a, "");
  }
  return out;
}

type RawSpan = { traceId: string; id: string; parentId: string | null; name: string; kind: string | null; start: number; end: number; status: string | null; attrs: Record<string, string | number | boolean> };

function rawSpan(s: Obj, traceHint: string | null): RawSpan | null {
  const attrs = { ...flatAttrs(s.attrs), ...flatAttrs(s.attributes), ...flatAttrs(s.span_attributes), ...flatAttrs(s.spanAttributes) };
  const id = str(s.spanId ?? s.span_id ?? s.id);
  const traceId = str(s.traceId ?? s.trace_id) ?? traceHint;
  const name = str(s.name ?? s.span_name ?? s.spanName);
  const start = toMs(s.startedAt ?? s.startTime ?? s.start_time ?? s.startTimeUnixNano ?? s.start ?? s.timestamp);
  let end = toMs(s.endedAt ?? s.endTime ?? s.end_time ?? s.endTimeUnixNano ?? s.end);
  const dur = num(s.durationMs ?? s.duration_ms) ?? null;
  if (end === null && start !== null && dur !== null) end = start + dur;
  if (!id || !traceId || !name || start === null) return null;
  const st = s.status;
  const status = isObj(st) ? str(st.code ?? st.status_code ?? st.message) : str(st ?? s.status_code ?? s.statusCode);
  return {
    traceId,
    id,
    parentId: str(s.parentSpanId ?? s.parent_span_id ?? s.parentId ?? s.parent_id),
    name,
    kind: str(s.kind ?? s.span_kind ?? s.spanKind ?? attrs["openinference.span.kind"]),
    start,
    end: end ?? start,
    status: status ? status.toLowerCase() : null,
    attrs,
  };
}

/** Every span-like object anywhere in the JSON (traces API responses nest them differently). */
function collectSpans(j: unknown, traceHint: string | null, acc: RawSpan[]) {
  if (Array.isArray(j)) {
    for (const x of j) collectSpans(x, traceHint, acc);
    return;
  }
  if (!isObj(j)) return;
  const hint = str(j.traceId ?? j.trace_id) ?? traceHint;
  if ((j.spanId ?? j.span_id) !== undefined || (j.name !== undefined && (j.startTime ?? j.start_time ?? j.startedAt ?? j.startTimeUnixNano) !== undefined && j.id !== undefined)) {
    const r = rawSpan(j, hint);
    if (r) acc.push(r);
  }
  for (const [k, v] of Object.entries(j)) if (k !== "attributes" && k !== "attrs" && (Array.isArray(v) || isObj(v))) collectSpans(v, hint, acc);
}

function bundleOf(runId: string): Obj | null {
  const p = firstExisting(join(RUNS, runId, `${runId}.json`), join(WEB_PUBLIC, "bundles", `${runId}.json`));
  return p ? (readJson(p) as Obj) : null;
}

function traceProbes(traceId: string, runId: string): Trace["probes"] {
  const b = bundleOf(runId);
  const probes = Array.isArray(b?.probes) ? (b!.probes as Obj[]) : [];
  return probes
    .filter((p) => p.traceId === traceId && typeof p.spanId === "string")
    .map((p) => {
      const o = isObj(p.observed) ? p.observed : {};
      return {
        id: String(p.id),
        spanId: String(p.spanId),
        claimId: String(p.claimId),
        committedAt: String(p.committedAt),
        ranAt: str(p.ranAt),
        predictionHash: String(p.predictionHash),
        observedStatus: num(o.status),
        observedOutcome: str(o.outcome),
        verdict: String(p.verdict),
      };
    });
}

function buildTrace(traceId: string, runId: string | null, raws: RawSpan[], source: string): Trace {
  const spans = raws.filter((r) => r.traceId === traceId);
  const t0 = Math.min(...spans.map((s) => s.start));
  const probes = runId ? traceProbes(traceId, runId) : [];
  const out: Span[] = spans
    .sort((a, b) => a.start - b.start)
    .map((s) => {
      const a = s.attrs;
      const attrStatus = num(a["http.status_code"] ?? a["http.response.status_code"] ?? a["notary.observed.status"] ?? a["notary.status"]);
      const pr = probes.find((p) => p.spanId === s.id);
      const httpStatus = attrStatus ?? pr?.observedStatus ?? null;
      return {
        id: s.id,
        parentId: s.parentId,
        name: s.name,
        kind: s.kind,
        agent: str(a["notary.agent"]),
        model: str(a["llm.model_id"] ?? a["gen_ai.request.model"] ?? a["llm.model_name"]),
        startMs: s.start - t0,
        endMs: s.end - t0,
        status: s.status,
        httpStatus,
        httpStatusSource: attrStatus !== null ? "span attribute" : pr?.observedStatus != null ? `run bundle, probe ${pr.id.split("-").at(-1)}` : null,
        attrs: Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("notary.") || k.startsWith("llm.") || k.startsWith("http."))),
        origin: "receipt" as const,
        attrsFromReceipt: true,
      };
    });
  return { traceId, runId, source, startedAt: Number.isFinite(t0) ? new Date(t0).toISOString() : null, meta: { spanCount: out.length, errorCount: null, detections: null, status: null, endpoint: null }, spans: out, probes };
}

/** traces.json as the voice agent writes it: { traces: [{ id, runId, source, startedAt, spans: [{ spanId, parentId,
 *  name, kind, startMs, endMs (relative), status, attributes, receipt? }] }] }. `receipt` is the same span's local
 *  receipt (spans.jsonl); its attributes are merged in and the source says so. */
function apiTrace(t: Obj, fileLabel: string): Trace | null {
  const traceId = str(t.id ?? t.traceId ?? t.trace_id);
  const spans = Array.isArray(t.spans) ? (t.spans as Obj[]) : [];
  if (!traceId || !spans.length || spans[0]!.startMs === undefined) return null;
  const runId = str(t.runId) ?? TRACE_RUNS.find((r) => r.traceId === traceId)?.runId ?? null;
  const probes = runId ? traceProbes(traceId, runId) : [];
  const out: Span[] = spans
    .map((s): Span => {
      const receipt = isObj(s.receipt) ? s.receipt : null;
      const a = { ...flatAttrs(s.attributes), ...(receipt ? flatAttrs(receipt.attributes) : {}) };
      const id = String(s.spanId);
      const pr = probes.find((p) => p.spanId === id);
      const attrStatus = num(a["http.status_code"] ?? a["http.response.status_code"]);
      return {
        id,
        parentId: str(s.parentId),
        name: String(s.name),
        kind: str(s.kind),
        agent: str(a["notary.agent"]),
        model: str(a["llm.model_id"] ?? a.model),
        startMs: num(s.startMs) ?? 0,
        endMs: num(s.endMs) ?? num(s.startMs) ?? 0,
        status: str(s.status)?.toLowerCase() ?? null,
        httpStatus: attrStatus ?? pr?.observedStatus ?? null,
        httpStatusSource: attrStatus !== null ? "span attribute" : pr?.observedStatus != null ? `run bundle · probe ${pr.id.split("-").at(-1)}` : null,
        attrs: Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("notary.") || k.startsWith("llm.") || k === "tool_name")),
        origin: "api" as const,
        attrsFromReceipt: !!receipt && Object.keys(flatAttrs(receipt.attributes)).some((k) => k.startsWith("notary.")),
      };
    })
    .concat(
      // Spans the run recorded locally that the API response does not contain: drawn, and labelled as receipts.
      (Array.isArray(t.inReceiptsNotInApi) ? (t.inReceiptsNotInApi as Obj[]) : []).map((r): Span => {
        const a = flatAttrs(r.attributes);
        const t0 = Date.parse(String(t.startedAt));
        return {
          id: String(r.spanId),
          parentId: str(r.parentId),
          name: String(r.name),
          kind: str(r.kind)?.toLowerCase() ?? null,
          agent: str(a["notary.agent"]),
          model: str(a["llm.model_id"]),
          startMs: Date.parse(String(r.startedAt)) - t0,
          endMs: Date.parse(String(r.endedAt)) - t0,
          status: str(r.status)?.toLowerCase() ?? null,
          httpStatus: null,
          httpStatusSource: null,
          attrs: Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("notary.") || k.startsWith("llm."))),
          origin: "receipt" as const,
          attrsFromReceipt: true,
        };
      }),
    )
    .sort((x, y) => x.startMs - y.startMs || (x.parentId === null ? -1 : 0));
  const src = str(t.source);
  const meta = { spanCount: num(t.spanCount), errorCount: num(t.errorCount), detections: num(t.detections), status: str(t.status), endpoint: str(t.endpoint) };
  return { traceId, runId, source: src ? `${src} (${fileLabel})` : fileLabel, startedAt: str(t.startedAt), meta, spans: out.sort((x, y) => x.startMs - y.startMs), probes };
}

function traces(): { traces: Trace[]; source: string } {
  const file = join(EXPL, "data/traces.json");
  if (existsSync(file)) {
    const j = readJson(file);
    const list = (isObj(j) && Array.isArray(j.traces) ? (j.traces as Obj[]) : Array.isArray(j) ? (j as Obj[]) : []).map((t) => apiTrace(t, "explainer/data/traces.json")).filter((t): t is Trace => !!t);
    const found = TRACE_RUNS.map((r) => list.find((t) => t.traceId === r.traceId)).filter((t): t is Trace => !!t);
    if (found.length) return { traces: found, source: "explainer/data/traces.json" };
    // Any other shape: collect span-like objects wherever they are.
    const raw: RawSpan[] = [];
    collectSpans(j, null, raw);
    const generic = TRACE_RUNS.filter((t) => raw.some((r) => r.traceId === t.traceId));
    if (generic.length) return { traces: generic.map((t) => buildTrace(t.traceId, t.runId, raw, "explainer/data/traces.json")), source: "explainer/data/traces.json" };
    console.warn("traces.json has none of the two traces: falling back to the local receipts");
  }
  const list: Trace[] = [];
  for (const t of TRACE_RUNS) {
    const p = join(RUNS, t.runId, "spans.jsonl");
    if (!existsSync(p)) continue;
    const raw: RawSpan[] = [];
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) if (line.trim()) collectSpans(JSON.parse(line), t.traceId, raw);
    list.push(buildTrace(t.traceId, t.runId, raw, `local span receipts · runs/${t.runId}/spans.jsonl`));
  }
  return { traces: list, source: "local span receipts (packages/core/runs/<runId>/spans.jsonl)" };
}

// ------------------------------------------------------------------------------- incidents

function incidents(): { list: Incident[]; source: string } {
  const runs = ["notarize-crustdata-20261012T011404Z", "notarize-dodo-20261012T012315Z"];
  const list: Incident[] = [];
  const sources: string[] = [];
  for (const runId of runs) {
    const p = firstExisting(join(EXPL, "data", `incidents-${runId}.json`), join(EXPL, "data", `incidents-${runId.split("-")[1]}.json`), join(EXPL, "data/incidents", `${runId}.json`), join(WEB_PUBLIC, "incidents", `${runId}.json`));
    if (!p) continue;
    sources.push(rel(p));
    const j = readJson(p) as Obj;
    const b = bundleOf(runId);
    const anomalies = Array.isArray(b?.anomalies) ? (b!.anomalies as Obj[]) : [];
    for (const i of (Array.isArray(j.incidents) ? j.incidents : []) as Obj[]) {
      const anomId = (Array.isArray(i.recordIds) ? (i.recordIds as string[]) : []).find((r) => r.startsWith("anom-"));
      const an = anomalies.find((a) => a.id === anomId);
      const res = isObj(i.resolution) ? i.resolution : {};
      list.push({
        id: String(i.id),
        runId,
        kind: String(i.kind),
        severity: String(i.severity),
        at: String(i.at),
        tool: str(i.tool),
        agent: str(i.agent),
        summary: String(i.summary),
        claimId: str(i.claimId),
        traceId: str(i.traceId),
        spanId: str(i.spanId),
        expected: an && isObj(an.expected) ? num(an.expected.status) : null,
        observed: an && isObj(an.observed) ? num(an.observed.status) : null,
        resolution: { status: String(res.status ?? ""), action: String(res.action ?? ""), summary: String(res.summary ?? "") },
      });
    }
  }
  return { list, source: sources.join(", ") };
}

// ------------------------------------------------------------------------------- entire, coverage, economics, eval suite

function entire(): Assets["data"]["entire"] {
  const p = firstExisting(join(EXPL, "data/entire.json"), join(WEB_PUBLIC, "evidence/entire.json"))!;
  const j = readJson(p) as Obj;
  const cps = (Array.isArray(j.checkpoints) ? j.checkpoints : []) as Obj[];
  const cov = isObj(j.coverage) ? j.coverage : null;
  return {
    source: rel(p),
    cliVersion: isObj(j.cli) ? str(j.cli.version) : null,
    checkpoints: cps.map((c) => ({ id: String(c.id), at: String(c.at), agent: String(c.agent ?? ""), model: str(c.model), commit: String(c.commit ?? ""), message: String(c.message ?? "") })),
    coverage: cov
      ? { sites: num(cov.sites) ?? 0, guarded: num(cov.guarded) ?? 0, rawByDesign: num(cov.rawByDesign) ?? 0, unguardedCallSites: num(cov.unguardedCallSites) ?? -1, callEdges: num(cov.callEdges) ?? 0, commit: String(cov.commit ?? "") }
      : null,
  };
}

function coverage(): Assets["data"]["coverage"] {
  const p = firstExisting(join(EXPL, "data/coverage.txt"));
  if (!p) return null;
  // eslint-disable-next-line no-control-regex
  const lines = readFileSync(p, "utf8").replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines.at(-1)) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  const cmd = lines.find((l) => /notary guards coverage/.test(l));
  return { source: rel(p), command: cmd ? cmd.replace(/^[$>]\s*/, "") : null, lines };
}

function economics(): Assets["data"]["economics"] {
  const p = firstExisting(join(EXPL, "data/economics.json"), join(WEB_PUBLIC, "economics.json"))!;
  const e = readJson(p) as Obj;
  const c = e.computed as Obj;
  const cpr = c.costPerRun as Obj;
  const cpc = c.costPerCertificate as Obj;
  const totals = c.totals as Obj;
  const csv = join(REPO, "export/cfo-inputs.csv");
  return {
    source: rel(p),
    costPerRun: { usd: num(cpr.usd)!, credits: num(cpr.credits)! },
    costPerCertificate: { usd: num(cpc.usd)!, credits: num(cpc.credits)! },
    liveRuns: num(totals.liveRuns) ?? 0,
    certified: ((c.tools as Obj[]) ?? []).map((t) => ({ tool: String(t.tool), certified: num(t.certified) ?? 0 })),
    planImported: e.plan !== null && e.plan !== undefined,
    exportPath: "export/cfo-inputs.csv",
    exportHead: existsSync(csv) ? readFileSync(csv, "utf8").split(/\r?\n/).filter(Boolean).slice(0, 5) : [],
  };
}

function evalSuite(): Assets["data"]["evalSuite"] {
  const p = join(EXPL, "data/eval-suite.json");
  if (existsSync(p)) {
    const j = readJson(p) as Obj;
    const f = flatAttrs(j);
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const hit = Object.entries(f).find(([key]) => key.toLowerCase() === k.toLowerCase());
        if (hit && num(hit[1]) !== null) return num(hit[1]);
      }
      return null;
    };
    const naive = pick("naiveUnsafe", "naive.unsafe", "naive.unsafeActions", "naive.unsafe_actions_total", "withoutNotary.unsafe", "without.unsafe");
    const guarded = pick("guardedUnsafe", "guarded.unsafe", "guarded.unsafeActions", "guarded.unsafe_actions_total", "withNotary.unsafe", "with.unsafe");
    const held = pick("refundsHeld", "guarded.refundsHeld", "withNotary.refundsHeld", "held");
    if (naive !== null && guarded !== null && held !== null) {
      return { source: str(j.source) ?? rel(p), label: str(j.label) ?? EVAL_LABEL, naiveUnsafe: naive, guardedUnsafe: guarded, held, queueSize: pick("queueSize", "guarded.queueSize", "requests") };
    }
    console.warn(`eval-suite.json: unrecognized shape (${Object.keys(f).slice(0, 12).join(", ")}), using src/data.json`);
  }
  const d = readJson(join(ROOT, "src/data.json")) as { naive: { unsafe: number }; guarded: { unsafe: number; refundsHeld: number; queueSize: number } };
  return { source: "packages/showreel/src/data.json (evaluation-suite bundles)", label: EVAL_LABEL, naiveUnsafe: d.naive.unsafe, guardedUnsafe: d.guarded.unsafe, held: d.guarded.refundsHeld, queueSize: d.guarded.queueSize };
}

function certificates(): { list: Assets["data"]["certificates"]; source: string } {
  const list: Assets["data"]["certificates"] = [];
  const files: string[] = [];
  for (const tool of ["crustdata", "dodo"]) {
    const p = join(WEB_PUBLIC, "certificates", `${tool}.json`);
    if (!existsSync(p)) continue;
    files.push(rel(p));
    const j = readJson(p) as Obj;
    for (const c of (Array.isArray(j.certificates) ? j.certificates : []) as Obj[]) {
      list.push({
        id: String(c.id),
        tool: String(c.tool),
        claimId: String(c.claimId),
        status: String(c.status),
        verdict: String(c.verdict ?? ""),
        scope: isObj(c.scope) ? String(c.scope.text ?? "") : String(c.scope ?? ""),
        evidence: Array.isArray(c.evidence) ? c.evidence.length : 0,
        sha256: String(c.sha256),
        adversaryVerdict: isObj(c.adversary) ? str(c.adversary.verdict) : null,
        issuedAt: String(c.issuedAt),
      });
    }
  }
  return { list, source: files.join(", ") };
}

function models(traces: Trace[]): Assets["data"]["models"] {
  const out: Assets["data"]["models"] = [];
  for (const t of traces)
    for (const s of t.spans) {
      if (!s.agent || !s.model) continue;
      const provider = str(s.attrs["llm.provider"]);
      if (!out.some((m) => m.agent === s.agent && m.model === s.model)) out.push({ agent: s.agent, model: s.model, provider });
    }
  // The provider is on the local receipts of the same LLM spans (runs/<runId>/spans.jsonl).
  for (const r of TRACE_RUNS) {
    const f = join(RUNS, r.runId, "spans.jsonl");
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const a = flatAttrs((JSON.parse(line) as Obj).attrs);
      const m = out.find((x) => x.model === a["llm.model_id"] && !x.provider);
      if (m && str(a["llm.provider"])) m.provider = str(a["llm.provider"]);
    }
  }
  return out;
}

function aws(): Assets["data"]["aws"] {
  const dir = join(REPO, "deploy/aws");
  const walk = (d: string, prefix = ""): string[] =>
    readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
  const doc = readFileSync(join(REPO, "docs/DEPLOY_AWS.md"), "utf8");
  const title = doc.match(/^# (.+)$/m)?.[1] ?? "";
  return { docPath: "docs/DEPLOY_AWS.md", docTitle: title, dir: "deploy/aws/", files: walk(dir) };
}

// ------------------------------------------------------------------------------- main

export function prepare(): Assets {
  const text = narration();
  const userVideo = join(EXPL, "user/neatlogs-incidents.mp4");
  const user = existsSync(userVideo) ? { src: mirror(userVideo, "user"), ...probe(userVideo) } : null;
  const t = traces();
  const inc = incidents();
  const d = readJson(join(ROOT, "src/data.json")) as { github: string };
  const assets: Assets = {
    narration: text,
    voice: voices(text),
    clips: clips(),
    user: { neatlogsIncidents: user && user.durationSec > 0 ? { src: user.src, durationSec: user.durationSec, width: user.width, height: user.height } : null },
    data: {
      traces: t.traces,
      tracesSource: t.source,
      incidents: inc.list,
      incidentsSource: inc.source,
      entire: entire(),
      coverage: coverage(),
      economics: economics(),
      evalSuite: evalSuite(),
      certificates: certificates().list,
      certificatesSource: certificates().source,
      models: models(t.traces),
      aws: aws(),
      github: d.github,
    },
  };
  const parsed = AssetsSchema.parse(assets);
  const json = `${JSON.stringify(parsed, null, 1)}\n`;
  const prev = existsSync(OUT_JSON) ? readFileSync(OUT_JSON, "utf8") : "";
  if (prev !== json) writeFileSync(OUT_JSON, json);
  return parsed;
}

export function summary(a: Assets): string {
  const v = SECTION_IDS.map((id) => `${id}:${a.voice[id]!.status === "real" ? "REAL" : "placeholder"}(${a.voice[id]!.durationSec.toFixed(1)}s)`).join(" ");
  const c = Object.entries(a.clips).map(([id, c]) => `${id}:${c.status === "real" ? `REAL(${c.durationSec.toFixed(1)}s, ${c.events.length} ev)` : "missing"}`).join(" ");
  return [
    `voice  ${v}`,
    `clips  ${c}`,
    `user   neatlogs-incidents: ${a.user.neatlogsIncidents ? "REAL" : "none"}`,
    `data   traces: ${a.data.traces.map((t) => `${t.traceId.slice(0, 8)} (${t.spans.length} spans)`).join(", ")} from ${a.data.tracesSource}`,
    `       incidents: ${a.data.incidents.length} from ${a.data.incidentsSource}; entire: ${a.data.entire.checkpoints.length} checkpoints (${a.data.entire.source}); coverage.txt: ${a.data.coverage ? `${a.data.coverage.lines.length} lines` : "missing"}; economics: ${a.data.economics.source}; eval suite: ${a.data.evalSuite.source}`,
  ].join("\n");
}

function signature(): string {
  const walk = (d: string): string[] =>
    existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [`${join(d, e.name)}:${statSync(join(d, e.name)).size}:${statSync(join(d, e.name)).mtimeMs}`])) : [];
  return walk(EXPL).concat(walk(join(REPO, "docs/video"))).sort().join("|");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const watch = process.argv.includes("--watch");
  let last = "";
  const run = () => {
    const sig = signature();
    if (sig === last) return;
    last = sig;
    try {
      const a = prepare();
      console.log(`[${new Date().toISOString().slice(11, 19)}] wrote src/explainer/assets.json\n${summary(a)}`);
    } catch (e) {
      // A half-written file (an agent still copying) fails parsing: retry on the next poll.
      console.error(`prep failed (will retry): ${(e as Error).message}`);
      last = "";
    }
  };
  run();
  if (watch) setInterval(run, 20_000);
}
