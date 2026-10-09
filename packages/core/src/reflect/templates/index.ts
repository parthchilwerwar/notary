/** Probe template registry, in TDD order. */
import type { ProbeTemplate } from "../../schema/index.js";
import { boundarySweep } from "./boundary_sweep.js";
import { headerBurst } from "./header_burst.js";
import { paginationCompleteness } from "./pagination_completeness.js";
import { retryAfterTimeout } from "./retry_after_timeout.js";
import { typeEdge } from "./type_edge.js";
import { unitRoundtrip } from "./unit_roundtrip.js";
import { unknownParam } from "./unknown_param.js";
import { writeThenRead } from "./write_then_read.js";
import type { ProbeTemplateModule } from "./types.js";

export * from "./types.js";
export {
  MAX_STEP_DELAY_MS,
  MAX_STEP_REPEAT,
  buildCostModel,
  estimateSteps,
  executeVariants,
  predictionsFor,
  probeIoFromTools,
  runSteps,
} from "./common.js";
export type { ClassTable } from "./common.js";
export { boundarySweep, headerBurst, paginationCompleteness, retryAfterTimeout, typeEdge, unitRoundtrip, unknownParam, writeThenRead };

export const TEMPLATES: readonly ProbeTemplateModule[] = [
  boundarySweep,
  unitRoundtrip,
  retryAfterTimeout,
  paginationCompleteness,
  writeThenRead,
  unknownParam,
  typeEdge,
  headerBurst,
];

export function templateByName(name: ProbeTemplate): ProbeTemplateModule {
  const t = TEMPLATES.find((m) => m.name === name);
  if (!t) throw new Error(`unknown probe template ${name}`);
  return t;
}
