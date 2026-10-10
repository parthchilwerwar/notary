// One data world for the explain engine: the real runs, or ONE fixture scenario. Answers are built
// inside a single world only; fixture and real data, and different fixture scenarios, never mix.
// Browser-safe (no Node imports): the export (export.ts) does the file loading.
import type { ToolCertificates } from "../schema/certificate.js";
import type { Belief, Probe, RunBundle, Tool } from "../schema/index.js";
import { RecordIndex, indexBundles, indexCertificates } from "./citations.js";

/** "(fixture scenario <name>)" in a fixture bundle's disclosure names its scenario; none = "default". */
const SCENARIO_RE = /\(fixture scenario ([A-Za-z0-9_-]+)\)/;

/**
 * World key of a bundle, from its own fields: "real" for sample:false, "synthetic" for the
 * dashboard's synthetic SAMPLE bundle (kind/variant sample), else "fixture:<scenario>".
 */
export function worldKeyOf(b: RunBundle): string {
  if (!b.sample) return "real";
  if (b.kind === "sample" || b.variant === "sample") return "synthetic";
  for (const d of b.disclosure) {
    const m = SCENARIO_RE.exec(d);
    if (m) return `fixture:${m[1]}`;
  }
  return "fixture:default";
}

export interface World {
  key: string;
  sample: boolean;
  /** Oldest first (startedAt, then runId). */
  bundles: RunBundle[];
  /** Certificates derived from these bundles (empty when none were supplied). */
  certificates: ToolCertificates[];
}

export function bundleOrder(x: RunBundle, y: RunBundle): number {
  return Date.parse(x.startedAt) - Date.parse(y.startedAt) || (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0);
}

/**
 * Build a world, refusing anything that would mix worlds: every bundle must have the same world
 * key, and every certificate/revocation must come from one of these bundles (same content hash).
 */
export function makeWorld(bundles: readonly RunBundle[], certificates: readonly ToolCertificates[] = [], key?: string): World {
  const keys = [...new Set(bundles.map(worldKeyOf))];
  if (keys.length > 1) throw new Error(`explain: bundles from different worlds cannot be explained together (${keys.join(", ")})`);
  const k = key ?? keys[0];
  if (k === undefined) throw new Error("explain: a world with no bundles needs an explicit key");
  if (keys.length === 1 && keys[0] !== k) throw new Error(`explain: world key ${k} does not match its bundles (${keys[0]})`);
  const sample = k !== "real";
  const ids = new Set(bundles.map((b) => b.runId));
  if (ids.size !== bundles.length) throw new Error("explain: duplicate runIds in one world");
  const hashes = new Map(bundles.map((b) => [b.runId, b.contentHash]));
  for (const t of certificates) {
    if (t.sample !== sample) throw new Error(`explain: ${t.tool} certificates are sample:${t.sample} but world ${k} is sample:${sample}`);
    for (const r of [...t.certificates, ...t.revocations]) {
      if (hashes.get(r.sourceBundle.runId) !== r.sourceBundle.contentHash) {
        throw new Error(`explain: ${r.id} comes from ${r.sourceBundle.runId}, which is not a bundle of world ${k} (or its hash differs)`);
      }
    }
  }
  return { key: k, sample, bundles: [...bundles].sort(bundleOrder), certificates: [...certificates] };
}

/** Every record of a world, citable. */
export function indexWorld(world: World, index = new RecordIndex()): RecordIndex {
  indexBundles(world.bundles, index);
  indexCertificates(world.certificates, index);
  return index;
}

/** Plain label for answers: "real runs" or "FIXTURE scenario <name> (simulated)". */
export function worldLabel(world: Pick<World, "key">): string {
  if (world.key === "real") return "real runs";
  if (world.key.startsWith("fixture:")) return `FIXTURE scenario ${world.key.slice("fixture:".length)} (simulated APIs and models, not a live run)`;
  return `${world.key} data (synthetic, not a run result)`;
}

/** The first bundle (oldest first) holding the probe, with its runId. */
export function findProbe(world: World, probeId: string): { probe: Probe; runId: string } | undefined {
  for (const b of world.bundles) {
    const p = b.probes.find((x) => x.id === probeId);
    if (p) return { probe: p, runId: b.runId };
  }
  return undefined;
}

/** The newest snapshot (beliefs.after) of a belief across the world. */
export function latestBelief(world: World, beliefId: string): { belief: Belief; runId: string } | undefined {
  for (let i = world.bundles.length - 1; i >= 0; i--) {
    const b = world.bundles[i]!;
    const x = b.beliefs.after.find((y) => y.id === beliefId);
    if (x) return { belief: x, runId: b.runId };
  }
  return undefined;
}

export function toolCertificates(world: World, tool: Tool): ToolCertificates | undefined {
  return world.certificates.find((t) => t.tool === tool);
}
