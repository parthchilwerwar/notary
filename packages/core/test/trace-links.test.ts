// neatlogs trace links (src/trace/links.ts), the doctor success record, the evidence generator
// (src/export/evidence.ts) and bundle builders' traceLinks. Every URL host here is a TEST host
// (*.test); the neatlogs SDK is replaced by an in-file fake so spans can be "exported" offline.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nextTrace = 0;
vi.mock("neatlogs", () => ({
  init: async () => {},
  trace: async (_opts: unknown, fn: (span: unknown) => unknown) => {
    nextTrace += 1;
    const traceId = nextTrace.toString(16).padStart(32, "a");
    const spanId = nextTrace.toString(16).padStart(16, "b");
    return await fn({ spanContext: () => ({ traceId, spanId }), setAttribute: () => {} });
  },
  flush: async () => true,
  shutdown: async () => true,
  log: () => {},
  wrapBedrock: <T>(c: T) => c,
}));

import { verifyBundle } from "../src/bundle/index.js";
import { reconOnly } from "../src/checker/notarize.js";
import type { ContractEntry } from "../src/contracts/types.js";
import {
  EvidenceSchema,
  PLACEHOLDER_URL,
  buildEvidence,
  writeEvidence,
  type EvidenceFacts,
} from "../src/export/evidence.js";
import { readDoctorRecord, runDoctor } from "../src/trace/doctor.js";
import { exportedTraceIdsInProcess, initTracing, setSpanSink, shutdownTracing, withSpan } from "../src/trace/index.js";
import {
  TRACE_TEMPLATE_ENV,
  bundleTraceLinks,
  deriveTraceLinkTemplate,
  exportedTraceIds,
  resolveTraceLinkTemplate,
  traceLinkFor,
  validateTraceLinkTemplate,
  writeNeatlogsConfig,
} from "../src/trace/links.js";
import { CreditLedger, DODO_TEST_BASE_URL, Recorder, computeContentHash, saveCassette } from "../src/tools/index.js";
import type { Cassette, Exchange } from "../src/tools/index.js";

const ID = "8e4a01d2811652fa2e8c4e4334642137";
const OTHER = "0123456789abcdef0123456789abcdef";
const HOST = "https://app.neatlogs.test";
const dashed = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notary-trace-links-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe("deriveTraceLinkTemplate", () => {
  it("templates the trace id in the path", () => {
    expect(deriveTraceLinkTemplate(`${HOST}/projects/p1/traces/${ID}`, ID)).toBe(`${HOST}/projects/p1/traces/{traceId}`);
  });

  it("keeps every query parameter that is not the id, and the fragment", () => {
    expect(deriveTraceLinkTemplate(`${HOST}/traces?project=p1&trace=${ID}&view=tree#spans`, ID)).toBe(
      `${HOST}/traces?project=p1&trace={traceId}&view=tree#spans`,
    );
  });

  it("accepts an upper-case id in the URL and an upper-case --trace-id", () => {
    expect(deriveTraceLinkTemplate(`${HOST}/t/${ID.toUpperCase()}`, ID)).toBe(`${HOST}/t/{traceId}`);
    expect(deriveTraceLinkTemplate(`${HOST}/t/${ID}`, ID.toUpperCase())).toBe(`${HOST}/t/{traceId}`);
  });

  it("recognises the dashed (UUID-style) form of the id", () => {
    expect(deriveTraceLinkTemplate(`${HOST}/t/${dashed(ID)}?tab=1`, ID)).toBe(`${HOST}/t/{traceIdDashed}?tab=1`);
  });

  it("refuses when the id is absent", () => {
    expect(() => deriveTraceLinkTemplate(`${HOST}/traces/${OTHER}`, ID)).toThrow(/does not appear/);
  });

  it("refuses when the id appears twice (ambiguous)", () => {
    expect(() => deriveTraceLinkTemplate(`${HOST}/traces/${ID}?focus=${ID}`, ID)).toThrow(/appears 2 times/);
    expect(() => deriveTraceLinkTemplate(`${HOST}/traces/${ID}?focus=${dashed(ID)}`, ID)).toThrow(/appears 2 times/);
  });

  it("refuses an id glued to more hex, a non-trace id, non-https URLs and credential-bearing URLs", () => {
    expect(() => deriveTraceLinkTemplate(`${HOST}/t/ff${ID}`, ID)).toThrow(/longer hex/);
    expect(() => deriveTraceLinkTemplate(`${HOST}/t/abc`, "abc")).toThrow(/32 hex/);
    expect(() => deriveTraceLinkTemplate(`http://app.neatlogs.test/t/${ID}`, ID)).toThrow(/https/);
    expect(() => deriveTraceLinkTemplate("not a url", ID)).toThrow(/not a URL/);
    expect(() => deriveTraceLinkTemplate(`https://u:p@app.neatlogs.test/t/${ID}`, ID)).toThrow(/credentials/);
    expect(() => deriveTraceLinkTemplate(`${HOST}/t/${ID}?access_token=zzz`, ID)).toThrow(/credential/);
    expect(() => deriveTraceLinkTemplate(`${HOST}/t/${ID}?apiKey=zzz`, ID)).toThrow(/credential/);
  });

  it("validateTraceLinkTemplate needs exactly one token and no other placeholder", () => {
    expect(() => validateTraceLinkTemplate(`${HOST}/t/`)).toThrow(/exactly one/);
    expect(() => validateTraceLinkTemplate(`${HOST}/{traceId}/{traceId}`)).toThrow(/exactly one/);
    expect(() => validateTraceLinkTemplate(`${HOST}/{org}/{traceId}`)).toThrow(/unknown/);
    expect(validateTraceLinkTemplate(`${HOST}/t/{traceId}`)).toBe(`${HOST}/t/{traceId}`);
  });
});

describe("traceLinkFor", () => {
  it("returns undefined without a template (ids stay text)", () => {
    expect(traceLinkFor(ID)).toBeUndefined();
    expect(traceLinkFor(ID, undefined)).toBeUndefined();
    expect(traceLinkFor(ID, "")).toBeUndefined();
  });

  it("fills the template, lower-casing the id; dashed templates get the dashed id", () => {
    expect(traceLinkFor(ID.toUpperCase(), `${HOST}/t/{traceId}?v=1`)).toBe(`${HOST}/t/${ID}?v=1`);
    expect(traceLinkFor(ID, `${HOST}/t/{traceIdDashed}`)).toBe(`${HOST}/t/${dashed(ID)}`);
  });

  it("never links something that is not a trace id", () => {
    expect(traceLinkFor("", `${HOST}/t/{traceId}`)).toBeUndefined();
    expect(traceLinkFor("runs/r1/spans.jsonl", `${HOST}/t/{traceId}`)).toBeUndefined();
  });
});

describe("template source", () => {
  it("none when neither env nor config exists", () => {
    expect(resolveTraceLinkTemplate({ env: {}, configPath: join(dir, "missing.json") })).toEqual({ source: "none" });
  });

  it("`notary trace-link` writes config/neatlogs.json, which is then the source", () => {
    const configPath = join(dir, "config", "neatlogs.json");
    const now = () => new Date("2026-10-10T12:00:00.000Z");
    const { config } = writeNeatlogsConfig(`${HOST}/traces/${ID}?org=o1`, ID, { configPath, now });
    expect(config).toEqual({ traceUrlTemplate: `${HOST}/traces/{traceId}?org=o1`, derivedFrom: { exampleTraceId: ID, derivedAt: "2026-10-10T12:00:00.000Z" } });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(config);
    expect(resolveTraceLinkTemplate({ env: {}, configPath })).toMatchObject({ template: `${HOST}/traces/{traceId}?org=o1`, source: "config" });
  });

  it("refuses to write a config when the id is not in the URL", () => {
    const configPath = join(dir, "neatlogs.json");
    expect(() => writeNeatlogsConfig(`${HOST}/traces/${OTHER}`, ID, { configPath })).toThrow(/does not appear/);
    expect(existsSync(configPath)).toBe(false);
  });

  it("env wins over config; an invalid template means no links, with the problem reported", () => {
    const configPath = join(dir, "neatlogs.json");
    writeNeatlogsConfig(`${HOST}/a/${ID}`, ID, { configPath });
    expect(resolveTraceLinkTemplate({ env: { [TRACE_TEMPLATE_ENV]: `${HOST}/b/{traceId}` }, configPath })).toEqual({ template: `${HOST}/b/{traceId}`, source: "env" });
    const bad = resolveTraceLinkTemplate({ env: { [TRACE_TEMPLATE_ENV]: `${HOST}/no-token` }, configPath });
    expect(bad.template).toBeUndefined();
    expect(bad.problem).toMatch(/exactly one/);
    writeFileSync(configPath, JSON.stringify({ traceUrlTemplate: "https://x.test/" }));
    expect(resolveTraceLinkTemplate({ env: {}, configPath }).template).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

function spansJsonl(runsDir: string, runId: string, recs: Array<{ traceId: string; exported?: true }>): void {
  mkdirSync(join(runsDir, runId), { recursive: true });
  const lines = recs.map((r, i) => JSON.stringify({ name: "notary.probe", spanId: `${i}`.padStart(16, "0"), startedAt: "", endedAt: "", attrs: {}, status: "ok", ...r }));
  writeFileSync(join(runsDir, runId, "spans.jsonl"), `${lines.join("\n")}\n`);
}

describe("bundleTraceLinks", () => {
  const receipt = (id: string) => `runs/r1/spans.jsonl#trace=${id}`;
  const tmpl = { template: `${HOST}/t/{traceId}`, source: "env" as const };

  it("no template: exactly the current fallback (receipts, or nothing)", () => {
    const runsDir = join(dir, "runs");
    spansJsonl(runsDir, "r1", [{ traceId: ID, exported: true }]);
    expect(bundleTraceLinks({ fallback: { [ID]: receipt(ID) }, runsDir, template: { source: "none" } })).toEqual({ [ID]: receipt(ID) });
    expect(bundleTraceLinks({ traceIds: [ID], runsDir, template: { source: "none" } })).toEqual({});
  });

  it("template: neatlogs URL only for exported traces; local-only traces keep their receipt or get nothing", () => {
    const runsDir = join(dir, "runs");
    spansJsonl(runsDir, "r1", [{ traceId: ID, exported: true }, { traceId: OTHER }]);
    expect(exportedTraceIds(runsDir).has(ID)).toBe(true);
    expect(exportedTraceIds(runsDir).has(OTHER)).toBe(false);
    expect(bundleTraceLinks({ fallback: { [ID]: receipt(ID), [OTHER]: receipt(OTHER) }, runsDir, template: tmpl })).toEqual({
      [ID]: `${HOST}/t/${ID}`,
      [OTHER]: receipt(OTHER),
    });
    expect(bundleTraceLinks({ traceIds: [ID, OTHER, ""], runsDir, template: tmpl })).toEqual({ [ID]: `${HOST}/t/${ID}` });
  });
});

// ---------------------------------------------------------------------------------------------
// A real builder: reconOnly (replay) over a hand-built TEST cassette whose exchange carries a trace id.

describe("bundle builders produce links only with a template", () => {
  const entries: ContractEntry[] = [
    {
      claim: {
        id: "test-page-max",
        tool: "dodo",
        operation: "dodo.listRefunds",
        param: "page_size",
        docText: "[test] hand-built claim",
        expect: { kind: "maxItems", max: 1 },
        docUrl: "https://example.com/test-doc",
      },
      recon: [{ op: "dodo.listRefunds", params: { page_size: 3 }, note: "over max" }],
    },
  ];

  function cassette(cassetteDir: string): void {
    const url = `${DODO_TEST_BASE_URL}/refunds?page_size=3`;
    const requestHash = new Recorder({ mode: "replay" }).hashRequest("GET", url, undefined);
    const exchange = {
      id: `dodo.listRefunds#${requestHash.slice(0, 12)}#0`,
      tool: "dodo",
      op: "dodo.listRefunds",
      method: "GET",
      url,
      requestHeaders: {},
      requestBody: null,
      status: 200,
      responseHeaders: {},
      responseBody: { items: [1, 2, 3] },
      latencyMs: 5,
      credits: null,
      recordedAt: "2026-01-01T00:00:00.000Z",
      requestHash,
      occurrence: 0,
      traceId: ID,
      spanId: "1518e64a727d8bac",
    } as Exchange;
    const c: Cassette = { name: "recon-dodo", tool: "dodo", createdAt: "2026-01-01T00:00:00.000Z", exchanges: [exchange], contentHash: computeContentHash([exchange]) };
    saveCassette(c, cassetteDir);
  }

  async function build(env: NodeJS.ProcessEnv, exported: boolean): Promise<Record<string, string>> {
    const runsDir = join(dir, "runs");
    if (exported) spansJsonl(runsDir, "earlier-live-run", [{ traceId: ID, exported: true }]);
    cassette(dir);
    const r = await reconOnly({ tool: "dodo", replay: true, cassetteDir: dir, runsDir, entries, env, ledger: new CreditLedger({ budget: 10 }) });
    expect(r.exitCode).toBe(0);
    expect(new Set(r.recon!.anomalies.map((a) => a.traceId))).toEqual(new Set([ID]));
    const checked = verifyBundle(JSON.parse(readFileSync(r.bundlePath!, "utf8")));
    expect(checked.ok).toBe(true);
    return checked.ok ? checked.bundle.traceLinks : {};
  }

  it("no template: traceLinks stay empty (ids are text)", async () => {
    expect(await build({}, true)).toEqual({});
  });

  it("template but the trace was never exported: still empty (no invented URL)", async () => {
    expect(await build({ [TRACE_TEMPLATE_ENV]: `${HOST}/t/{traceId}` }, false)).toEqual({});
  });

  it("template and an exported trace: the neatlogs URL", async () => {
    expect(await build({ [TRACE_TEMPLATE_ENV]: `${HOST}/t/{traceId}` }, true)).toEqual({ [ID]: `${HOST}/t/${ID}` });
  });
});

// ---------------------------------------------------------------------------------------------
// With the (fake) SDK on: exported spans are marked, and doctor records its success.

describe("with tracing on (fake neatlogs SDK)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.NEATLOGS_API_KEY;
    process.env.NEATLOGS_API_KEY = "fake-neatlogs-key-for-tests";
  });
  afterEach(async () => {
    setSpanSink(null);
    await shutdownTracing();
    if (savedKey === undefined) delete process.env.NEATLOGS_API_KEY;
    else process.env.NEATLOGS_API_KEY = savedKey;
  });

  it("withSpan marks SDK spans `exported: true` in spans.jsonl and in-process", async () => {
    expect((await initTracing()).enabled).toBe(true);
    const sink = join(dir, "runs", "r-live", "spans.jsonl");
    setSpanSink(sink);
    let traceId = "";
    await withSpan("notary.probe", {}, () => 1, { onSpan: (ids) => (traceId = ids.traceId) });
    const rec = JSON.parse(readFileSync(sink, "utf8").trim());
    expect(rec).toMatchObject({ traceId, exported: true });
    expect(exportedTraceIdsInProcess().has(traceId)).toBe(true);
    expect(exportedTraceIds(join(dir, "runs")).has(traceId)).toBe(true);
  });

  it("runDoctor records its success (ids + timestamp only); a disabled run records nothing", async () => {
    const recordPath = join(dir, "config", "neatlogs-doctor.json");
    const report = await runDoctor({ recordPath, now: () => new Date("2026-10-11T09:00:00.000Z") });
    expect(report.spanEmitted).toBe(true);
    const rec = readDoctorRecord(recordPath);
    expect(rec).toEqual({ traceId: report.traceId, spanId: report.spanId, flushedAt: "2026-10-11T09:00:00.000Z", source: "notary doctor" });
    expect(readFileSync(recordPath, "utf8")).not.toContain("fake-neatlogs-key-for-tests");

    await shutdownTracing();
    delete process.env.NEATLOGS_API_KEY;
    const other = join(dir, "other.json");
    expect((await runDoctor({ recordPath: other })).spanEmitted).toBe(false);
    expect(existsSync(other)).toBe(false);
  });
});

describe("the committed doctor record", () => {
  // Seeded from DECISIONS #93; every later successful `notary doctor` overwrites it with its own real ids.
  it("is a valid record: DECISIONS #93's seed, or a later real doctor success", () => {
    const rec = readDoctorRecord();
    expect(rec).toBeDefined();
    if (rec!.source.startsWith("seeded")) expect(rec).toMatchObject({ traceId: ID, spanId: "1518e64a727d8bac", flushedAt: "2026-10-10" });
    else expect(rec).toMatchObject({ source: "notary doctor", flushedAt: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/) });
  });
});

// ---------------------------------------------------------------------------------------------

describe("buildEvidence: statuses follow the facts", () => {
  const doctor = { traceId: ID, spanId: "1518e64a727d8bac", flushedAt: "2026-10-10", source: "seeded from DECISIONS #93" };
  const base: EvidenceFacts = {
    doctor,
    traceTemplate: { source: "none" },
    exportedRunTraces: 0,
    neatlogsCliOnPath: false,
    entire: { onPath: false, checkpointRefs: [] },
    businessPlan: false,
    economicsJson: false,
  };
  const by = (facts: EvidenceFacts, name: string) => buildEvidence(facts).find((e) => e.name === name)!;
  const allLinks = (facts: EvidenceFacts) => buildEvidence(facts).flatMap((e) => e.links.map((l) => l.url));

  it("today's facts: neatlogs live (SDK export only, no trace link), Entire pending, cfo.ai pending", () => {
    const ev = buildEvidence(base);
    expect(EvidenceSchema.safeParse(ev).success).toBe(true);
    expect(ev.map((e) => [e.name, e.status])).toEqual([
      ["neatlogs", "live"],
      ["Entire", "pending"],
      ["cfo.ai", "pending"],
    ]);
    expect(by(base, "neatlogs").links.map((l) => l.url)).toEqual(["https://github.com/neatlogs/neatlogs-typescript"]);
    expect(by(base, "neatlogs").notes).toMatch(/SDK export only: on Oct 10.*trace 8e4a01d2811652fa2e8c4e4334642137, span 1518e64a727d8bac; DECISIONS #93/);
    expect(by(base, "neatlogs").notes).toMatch(/no trace link/);
    expect(by(base, "Entire").links.map((l) => l.url)).toEqual(["https://docs.entire.io/cli-reference/graph"]);
    expect(by(base, "Entire").notes).toMatch(/not installed/);
    expect(by(base, "cfo.ai").links).toEqual([]);
  });

  it("neatlogs: pending without a recorded doctor success; a trace link only with a template", () => {
    expect(by({ ...base, doctor: undefined }, "neatlogs").status).toBe("pending");
    expect(by({ ...base, doctor: undefined, traceTemplate: { template: `${HOST}/t/{traceId}`, source: "env" } }, "neatlogs").links).toHaveLength(1);
    const linked = by({ ...base, traceTemplate: { template: `${HOST}/t/{traceId}`, source: "config", derivedAt: "2026-10-11T00:00:00.000Z" } }, "neatlogs");
    expect(linked.status).toBe("live");
    expect(linked.links.map((l) => l.url)).toEqual(["https://github.com/neatlogs/neatlogs-typescript", `${HOST}/t/${ID}`]);
    expect(linked.notes).toMatch(/config\/neatlogs\.json \(derived from a real trace URL on Oct 11\)/);
    expect(by({ ...base, exportedRunTraces: 3 }, "neatlogs").notes).toMatch(/3 notarize\/run trace/);
  });

  it("Entire: live only with the CLI on PATH AND a checkpoint ref", () => {
    expect(by({ ...base, entire: { onPath: true, checkpointRefs: [] } }, "Entire").status).toBe("pending");
    expect(by({ ...base, entire: { onPath: false, checkpointRefs: ["refs/heads/entire/checkpoints/v1"] } }, "Entire").status).toBe("pending");
    const live = by({ ...base, entire: { onPath: true, checkpointRefs: ["refs/heads/entire/checkpoints/v1"] } }, "Entire");
    expect(live.status).toBe("live");
    expect(live.notes).toContain("refs/heads/entire/checkpoints/v1");
  });

  it("cfo.ai: live only when docs/BUSINESS.md exists", () => {
    expect(by({ ...base, economicsJson: true }, "cfo.ai").status).toBe("pending");
    expect(by({ ...base, businessPlan: true }, "cfo.ai").status).toBe("live");
    expect(by({ ...base, businessPlan: true }, "cfo.ai").links).toEqual([]);
  });

  it("never emits a placeholder link, whatever the facts", () => {
    const variants: EvidenceFacts[] = [
      base,
      { ...base, doctor: undefined },
      { ...base, traceTemplate: { template: `${HOST}/t/{traceId}`, source: "env" }, entire: { onPath: true, checkpointRefs: ["refs/heads/entire/x"] }, businessPlan: true, economicsJson: true },
    ];
    for (const f of variants) for (const url of allLinks(f)) expect(PLACEHOLDER_URL.test(url)).toBe(false);
  });

  it("writeEvidence writes the generated file", () => {
    const path = join(dir, "evidence.json");
    const { evidence } = writeEvidence({ path, facts: base });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(evidence);
  });
});
