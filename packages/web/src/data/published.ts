// The published files under packages/web/public/ — the ONLY module that knows their paths.
// ReplaySource reads everything from here; LiveSource reads fixture runs, fixture certificates
// and the precomputed explain answers from here (no API serves simulated data).
//
//   bundles/index.json, bundles/<runId>.json, bundles/<runId>.timeline.json      published runs
//   bundles/fixture/index.json, bundles/fixture/<runId>(.timeline).json            fixture runs (sample: true)
//   certificates/report.json, certificates/<tool>.json                              real certificates
//   certificates/fixture/index.json, certificates/fixture/<scenario>/…              fixture scenarios
//   content/explain.json, evidence/evidence.json, economics.json                    optional content
import { z } from "zod";
import {
  CertificateReportSchema,
  ExplainFileSchema,
  FixtureIndexSchema,
} from "../../../core/src/schema";
import type {
  BundleIndexEntry,
  ExplainFile,
  FixtureIndex,
  RunBundle,
  TimelineFile,
} from "../../../core/src/schema";
import { globalFetch, readJson, readOptionalJson, type FetchImpl } from "./http";
import { byNewest, chooseScenario, parseBundleIndex, validateBundle, verifyTimelineFile, verifyToolFile } from "./verify";
import type { CertificateWorld } from "./types";

/** Where a published run lives. */
export type RunDir = "bundles" | "bundles/fixture";
export type PublishedEntry = BundleIndexEntry & { dir: RunDir };

/** A certificate world plus the fixture scenario it came from and why it was chosen. */
export type CertificateWorldDetail = CertificateWorld & {
  scenario?: string;
  scenarioReason?: string;
};

/** Thrown when a run has no published (or served) timeline. The UI shows "not published", not an error. */
export class TimelineMissingError extends Error {
  constructor(readonly runId: string) {
    super(`No timeline is published for ${runId}.`);
    this.name = "TimelineMissingError";
  }
}

/** Human-readable names of the published files, for copy that tells people where data comes from. */
export const PUBLISHED_FILES = {
  evidence: "public/evidence/evidence.json",
  explain: "public/content/explain.json",
  economics: "public/economics.json",
  certificates: "public/certificates/",
  bundles: "public/bundles/",
} as const;

const baseUrl = (): string => String(import.meta.env.BASE_URL ?? "/");

/** URL of the published tool-evidence file (for a "download the receipts" link). */
export const evidenceFileUrl = (): string => `${baseUrl()}evidence/evidence.json`;

export const evidenceSchema = z.array(
  z.object({
    name: z.string(),
    purpose: z.string(),
    status: z.enum(["live", "pending"]),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
    notes: z.string().optional(),
  }),
);
export type EvidenceEntry = z.infer<typeof evidenceSchema>[number];

export class PublishedFiles {
  private readonly base: string;
  private readonly fetchImpl: FetchImpl;
  /** runId → where it was listed, from the last catalog read. */
  private dirs = new Map<string, PublishedEntry>();
  /** Verified bundles keyed by dir/runId@contentHash (the index pins the hash). */
  private bundles = new Map<string, RunBundle>();

  constructor(opts: { base?: string; fetchImpl?: FetchImpl } = {}) {
    this.base = opts.base ?? baseUrl();
    this.fetchImpl = opts.fetchImpl ?? globalFetch;
  }

  private url(path: string) {
    return `${this.base}${path}`;
  }

  /** bundles/index.json (required). */
  async primaryIndex(signal?: AbortSignal): Promise<BundleIndexEntry[]> {
    const raw = await readJson(this.url("bundles/index.json"), "bundles/index.json", signal, this.fetchImpl);
    return [...parseBundleIndex(raw)].sort(byNewest);
  }

  /** bundles/fixture/index.json (optional); every entry must be `sample: true`. */
  async fixtureIndex(signal?: AbortSignal): Promise<BundleIndexEntry[]> {
    const response = await this.fetchImpl(this.url("bundles/fixture/index.json"), {
      signal,
      cache: "no-store",
    });
    if (response.headers.get("x-notary-hash-mismatch") === "1")
      throw new Error("Fixture index hash mismatch. Data withheld.");
    if (response.ok && response.headers.get("content-type")?.includes("json")) {
      let raw: unknown;
      try {
        raw = await response.json();
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        throw new Error("The fixture index is not valid JSON. Data withheld.");
      }
      let fixtures: BundleIndexEntry[];
      try {
        fixtures = parseBundleIndex(raw, "Fixture index");
      } catch {
        throw new Error("The fixture index does not match the shared Notary schema. Data withheld.");
      }
      if (fixtures.some((e) => !e.sample))
        throw new Error("Fixture directory contains a live bundle. Data withheld.");
      return fixtures;
    }
    if (!response.ok && response.status !== 404) throw new Error("Unable to load the fixture index.");
    return [];
  }

  /** Every published run (primary + fixture), newest first; run ids unique across both. */
  async catalog(signal?: AbortSignal): Promise<PublishedEntry[]> {
    const [primary, fixture] = await Promise.all([this.primaryIndex(signal), this.fixtureIndex(signal)]);
    const all: PublishedEntry[] = [
      ...primary.map((e) => ({ ...e, dir: "bundles" as const })),
      ...fixture.map((e) => ({ ...e, dir: "bundles/fixture" as const })),
    ];
    if (new Set(all.map((e) => e.runId)).size !== all.length)
      throw new Error("Duplicate run identifiers across bundle sources.");
    this.dirs = new Map(all.map((e) => [e.runId, e]));
    return all.sort(byNewest);
  }

  /** Published fixture runs only (LiveSource merges these next to the API's real runs). */
  async fixtureCatalog(signal?: AbortSignal): Promise<PublishedEntry[]> {
    const fixture = (await this.fixtureIndex(signal)).map((e) => ({ ...e, dir: "bundles/fixture" as const }));
    for (const e of fixture) this.dirs.set(e.runId, e);
    return fixture;
  }

  /** The index entry of a published run, reading the catalog if it has not been read yet. */
  async entry(runId: string, signal?: AbortSignal): Promise<PublishedEntry> {
    if (!this.dirs.has(runId)) await this.catalog(signal);
    const entry = this.dirs.get(runId);
    if (!entry) throw new Error(`Run ${runId} is not published.`);
    return entry;
  }

  /** Whether the last catalog read listed this run. */
  knows(runId: string): boolean {
    return this.dirs.has(runId);
  }

  /** A published bundle, schema-checked and hash-verified against its index entry. */
  async bundle(runId: string, signal?: AbortSignal): Promise<RunBundle> {
    const entry = await this.entry(runId, signal);
    const key = `${entry.dir}/${runId}@${entry.contentHash}`;
    const cached = this.bundles.get(key);
    if (cached) return cached;
    const path = `${entry.dir}/${encodeURIComponent(runId)}.json`;
    const { dir: _dir, ...indexEntry } = entry;
    const bundle = validateBundle(await readJson(this.url(path), path, signal, this.fetchImpl), indexEntry);
    this.bundles.set(key, bundle);
    return bundle;
  }

  /** The run's published timeline, tied to its verified bundle. TimelineMissingError when absent. */
  async timeline(runId: string, signal?: AbortSignal): Promise<TimelineFile> {
    const entry = await this.entry(runId, signal);
    const bundle = await this.bundle(runId, signal);
    const path = `${entry.dir}/${encodeURIComponent(runId)}.timeline.json`;
    const raw = await readOptionalJson(this.url(path), path, signal, this.fetchImpl);
    if (raw === undefined) throw new TimelineMissingError(runId);
    return verifyTimelineFile(raw, bundle);
  }

  /** certificates/fixture/index.json, validated; null when not published. */
  async fixtureCertificateIndex(signal?: AbortSignal): Promise<FixtureIndex | null> {
    const raw = await readOptionalJson(
      this.url("certificates/fixture/index.json"),
      "certificates/fixture/index.json",
      signal,
      this.fetchImpl,
    );
    if (raw === undefined) return null;
    const index = FixtureIndexSchema.safeParse(raw);
    if (!index.success)
      throw new Error("The fixture certificate index does not match the shared schema. Data withheld.");
    return index.data;
  }

  /**
   * Real certificates (sample false) or the fixture scenario for `runId` (sample true). Every file
   * is schema-checked, pinned by its report's hash, and every record's seal recomputed.
   * `report: null` = nothing published for that world.
   */
  async certificateWorld(sample: boolean, runId?: string, signal?: AbortSignal): Promise<CertificateWorldDetail> {
    let base = "certificates/";
    let scenario: string | undefined;
    let scenarioReason: string | undefined;
    if (sample) {
      const index = await this.fixtureCertificateIndex(signal);
      const chosen = index ? chooseScenario(index, runId) : undefined;
      // "fixture:none": no fixture certificate export is published; report null says so.
      if (!chosen) return { world: "fixture:none", sample: true, tools: [], report: null };
      scenario = chosen.scenario.scenario;
      scenarioReason = chosen.reason;
      const reportPath = chosen.scenario.report;
      base = `certificates/fixture/${reportPath.slice(0, reportPath.lastIndexOf("/") + 1)}`;
    }
    const world: CertificateWorld["world"] = sample ? `fixture:${scenario}` : "real";
    const rawReport = await readOptionalJson(this.url(`${base}report.json`), `${base}report.json`, signal, this.fetchImpl);
    if (rawReport === undefined) return { world, sample, tools: [], report: null, scenario, scenarioReason };
    const parsed = CertificateReportSchema.safeParse(rawReport);
    if (!parsed.success)
      throw new Error("The certificate report does not match the shared schema. Data withheld.");
    const report = parsed.data;
    if (report.sample !== sample || report.scenario !== scenario)
      throw new Error("The certificate report belongs to a different data world. Data withheld.");
    const tools = await Promise.all(
      report.tools.map(async (entry) => {
        const path = `${base}${entry.file}`;
        const raw = await readOptionalJson(this.url(path), path, signal, this.fetchImpl);
        if (raw === undefined) throw new Error(`${entry.file} is listed in the report but missing.`);
        return verifyToolFile(raw, report.toolFileHashes[entry.file], sample, entry.file);
      }),
    );
    return { world, sample, tools, report, scenario, scenarioReason };
  }

  /** content/explain.json, validated; null when not published. */
  async explain(signal?: AbortSignal): Promise<ExplainFile | null> {
    const raw = await readOptionalJson(this.url("content/explain.json"), "content/explain.json", signal, this.fetchImpl);
    if (raw === undefined) return null;
    const parsed = ExplainFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error("explain.json does not match the shared schema. Answers withheld.");
    return parsed.data;
  }

  /** evidence/evidence.json (tool integration receipts); [] when not published. */
  async evidence(signal?: AbortSignal): Promise<EvidenceEntry[]> {
    const r = await this.fetchImpl(this.url("evidence/evidence.json"), { signal, cache: "no-store" });
    if (r.status === 404 || (r.ok && !r.headers.get("content-type")?.includes("json"))) return [];
    if (!r.ok) throw new Error("Tool evidence could not be loaded.");
    let raw: unknown;
    try {
      raw = await r.json();
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new Error("evidence/evidence.json is not valid JSON. Data withheld.");
    }
    const parsed = evidenceSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error("evidence/evidence.json does not match the evidence schema. Data withheld.");
    return parsed.data;
  }

  /** economics.json (the cfo.ai plan), raw; undefined when not published. */
  async economics(signal?: AbortSignal): Promise<unknown | undefined> {
    return readOptionalJson(this.url("economics.json"), "economics.json", signal, this.fetchImpl);
  }
}
