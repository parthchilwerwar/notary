/**
 * export/guards.json: every guard (active and retired) carried by the newest full notarize bundle
 * of each tool. `generatedFrom` names those bundles; both arrays are empty when none exist.
 */
import type { Guard, RunBundle, Tool } from "../schema/index.js";
import { latestNotarize } from "./collect.js";

export interface GuardsJson {
  generatedFrom: { runId: string; contentHash: string; tool: Tool }[];
  guards: Guard[];
}

export function buildGuardsJson(bundles: readonly RunBundle[]): GuardsJson {
  const generatedFrom: GuardsJson["generatedFrom"] = [];
  const byId = new Map<string, Guard>();
  for (const tool of ["crustdata", "dodo"] as const) {
    const b = latestNotarize(bundles, tool);
    if (!b) continue;
    generatedFrom.push({ runId: b.runId, contentHash: b.contentHash, tool });
    for (const g of b.guards) byId.set(g.id, g);
  }
  const guards = [...byId.values()].sort((x, y) => Number(y.active) - Number(x.active) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { generatedFrom, guards };
}
