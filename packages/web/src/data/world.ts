// Data worlds (moved from the old Ask model). Mirrors packages/core/src/explain/world.ts
// `worldKeyOf` (web may not import it): "real" for sample:false, "synthetic" for the dashboard's
// SAMPLE bundle, else "fixture:<scenario>" from the "(fixture scenario <name>)" disclosure; none =
// "default". Worlds never mix: not in a chart, a table, an answer or a chat turn.
import type { ExplainAnswer, RunBundle } from "../../../core/src/schema";

export type WorldKey = string;
export type WorldFields = Pick<RunBundle, "sample" | "kind" | "variant" | "disclosure">;

const SCENARIO_RE = /\(fixture scenario ([A-Za-z0-9_-]+)\)/;

export function worldKeyOf(b: WorldFields): WorldKey {
  if (!b.sample) return "real";
  if (b.kind === "sample" || b.variant === "sample") return "synthetic";
  for (const d of b.disclosure) {
    const m = SCENARIO_RE.exec(d);
    if (m) return `fixture:${m[1]}`;
  }
  return "fixture:default";
}

export function worldLabel(key: WorldKey): string {
  if (key === "real") return "real runs";
  if (key === "synthetic") return "synthetic sample data";
  if (key.startsWith("fixture:")) return `fixture scenario ${key.slice("fixture:".length)} (simulated APIs)`;
  return key;
}

/** runId -> world key for every verified bundle. */
export function worldIndex(bundles: readonly (WorldFields & { runId: string })[]): Map<string, WorldKey> {
  return new Map(bundles.map((b) => [b.runId, worldKeyOf(b)]));
}

/**
 * The one world an explain answer belongs to, from the bundles its runIds name. Undefined when a run
 * is unknown, the runs span worlds, or the answer's `sample` flag disagrees: such an answer is never
 * used (a world we can't prove is a world we might mix).
 */
export function answerWorld(
  answer: Pick<ExplainAnswer, "runIds" | "sample">,
  worlds: Map<string, WorldKey>,
): WorldKey | undefined {
  if (!answer.runIds.length) return undefined;
  const keys = new Set(answer.runIds.map((id) => worlds.get(id)));
  if (keys.size !== 1) return undefined;
  const [key] = keys;
  if (key === undefined) return undefined;
  if ((key !== "real") !== answer.sample) return undefined;
  return key;
}
