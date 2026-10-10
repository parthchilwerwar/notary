// The citable records of ONE data world for POST /api/ask, beyond the bundles themselves:
// timelines, approvals, and certificates/revocations. Read-only file loading; every file is
// schema-validated and must belong to a bundle of the chosen world, else it is skipped.
//
//   timelines     runs/<runId>/timeline.jsonl (source of truth; only when runs/<runId>/ holds this same
//                 bundle, by content hash), else the published <bundle dir>/<runId>.timeline.json whose
//                 runId, sample flag and bundleHash match the bundle
//   approvals     runs/<runId>/approvals.json (same ownership rule as the timeline)
//   certificates  real: <certificatesDir>/<tool>.json; fixture:<scenario>:
//                 <certificatesDir>/fixture/<scenario>/<tool>.json; synthetic: none. A certificate or
//                 revocation is kept only when its sourceBundle (runId + contentHash) is a bundle of
//                 the world.
//
// Imports nothing that can act (test/ask.test.ts checks the graph).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RecordIndex, indexApprovals, indexBundles, indexCertificates, indexTimelines } from "../explain/citations.js";
import { worldKeyOf } from "../explain/world.js";
import { ApprovalsFileSchema } from "../schema/approval.js";
import { BundleIndexSchema } from "../schema/bundle.js";
import { ToolCertificatesSchema } from "../schema/certificate.js";
import type { ToolCertificates } from "../schema/certificate.js";
import { ToolSchema } from "../schema/common.js";
import type { RunBundle } from "../schema/index.js";
import { TimelineFileSchema } from "../schema/timeline.js";
import type { TimelineEvent } from "../schema/timeline.js";
import { readTimeline, timelinePath } from "../timeline/store.js";
import type { LoadedBundle } from "./bundle-source.js";

export interface WorldSources {
  runsDir?: string | null;
  certificatesDir?: string | null;
}

export interface WorldRecords {
  key: string;
  bundles: RunBundle[];
  index: RecordIndex;
  counts: { timelineEvents: number; approvals: number; certificates: number; revocations: number };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** True when runs/<runId>/ holds this exact bundle (its own index entry has the same content hash). */
function ownsRunDir(runDir: string, b: RunBundle): boolean {
  const parsed = BundleIndexSchema.safeParse(readJson(join(runDir, "index.json")));
  return parsed.success && parsed.data.some((e) => e.runId === b.runId && e.contentHash === b.contentHash);
}

function timelineFor(l: LoadedBundle, runsDir: string | null): TimelineEvent[] {
  const b = l.bundle;
  const runDir = runsDir === null ? null : join(runsDir, b.runId);
  if (runDir && existsSync(timelinePath(runDir)) && ownsRunDir(runDir, b)) {
    try {
      return readTimeline(runDir);
    } catch {
      return [];
    }
  }
  const published = TimelineFileSchema.safeParse(readJson(join(l.dir, `${b.runId}.timeline.json`)));
  if (published.success && published.data.runId === b.runId && published.data.sample === b.sample && published.data.bundleHash === b.contentHash) {
    return published.data.events;
  }
  return [];
}

function approvalsFor(b: RunBundle, runsDir: string | null): { id: string; traceId?: string }[] {
  if (runsDir === null) return [];
  const runDir = join(runsDir, b.runId);
  if (!existsSync(join(runDir, "approvals.json")) || !ownsRunDir(runDir, b)) return [];
  const parsed = ApprovalsFileSchema.safeParse(readJson(join(runDir, "approvals.json")));
  return parsed.success && parsed.data.runId === b.runId ? parsed.data.approvals : [];
}

/** Certificate files of the world, keeping only records derived from one of its bundles. */
export function worldCertificates(key: string, bundles: readonly RunBundle[], certificatesDir: string | null): ToolCertificates[] {
  if (certificatesDir === null) return [];
  let dir: string;
  let scenario: string | undefined;
  if (key === "real") dir = certificatesDir;
  else if (key.startsWith("fixture:")) {
    scenario = key.slice("fixture:".length);
    if (!/^[A-Za-z0-9_-]+$/.test(scenario)) return [];
    dir = join(certificatesDir, "fixture", scenario);
  } else return [];
  const sample = key !== "real";
  const hashes = new Map(bundles.map((b) => [b.runId, b.contentHash]));
  const fromWorld = (r: { sourceBundle: { runId: string; contentHash: string } }) => hashes.get(r.sourceBundle.runId) === r.sourceBundle.contentHash;
  const out: ToolCertificates[] = [];
  for (const tool of ToolSchema.options) {
    const parsed = ToolCertificatesSchema.safeParse(readJson(join(dir, `${tool}.json`)));
    if (!parsed.success) continue;
    const t = parsed.data;
    if (t.tool !== tool || t.sample !== sample || t.scenario !== scenario) continue;
    out.push({ ...t, certificates: t.certificates.filter(fromWorld), revocations: t.revocations.filter(fromWorld) });
  }
  return out;
}

/** Index every citable record of one world (bundles + timelines + approvals + certificates). */
export function indexWorldRecords(key: string, loaded: readonly LoadedBundle[], src: WorldSources = {}): WorldRecords {
  const inWorld = loaded.filter((l) => worldKeyOf(l.bundle) === key);
  const bundles = inWorld.map((l) => l.bundle);
  const runsDir = src.runsDir ?? null;
  const index = indexBundles(bundles);
  const timelines = inWorld.map((l) => ({ runId: l.bundle.runId, sample: l.bundle.sample, events: timelineFor(l, runsDir) }));
  indexTimelines(timelines, index);
  const approvals = bundles.map((b) => ({ runId: b.runId, sample: b.sample, approvals: approvalsFor(b, runsDir) }));
  indexApprovals(approvals, index);
  const certs = worldCertificates(key, bundles, src.certificatesDir ?? null);
  indexCertificates(certs, index);
  return {
    key,
    bundles,
    index,
    counts: {
      timelineEvents: timelines.reduce((n, t) => n + t.events.length, 0),
      approvals: approvals.reduce((n, a) => n + a.approvals.length, 0),
      certificates: certs.reduce((n, c) => n + c.certificates.length, 0),
      revocations: certs.reduce((n, c) => n + c.revocations.length, 0),
    },
  };
}
