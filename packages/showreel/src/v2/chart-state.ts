// The chart morph's timing, shared by the chart (Chart.tsx) and the stills check (scripts/stills.ts).
import { IN, LINE, OUT, p } from "../theme";
import { V } from "./timeline";

/**
 * The morph's state at a frame, shared with scripts/stills.ts (which checks it against the pixels):
 * the unsafe stacks un-reveal completely first; only then does the label hand over to "With Notary"
 * and Notary's held stacks rise. No frame pairs "With Notary" with a red unsafe row.
 */
export function chartState(frame: number) {
  const t0 = V.chartIn;
  const dissolve = p(frame, t0 + 4, 10, LINE);
  const withLabel = dissolve >= 1 ? p(frame, t0 + 14, 5) : 0;
  const rise = dissolve >= 1 ? p(frame, t0 + 14, 10, LINE) : 0;
  return { enter: p(frame, t0, 12, OUT), leave: p(frame, V.enforceOut - 2, 8, IN), dissolve, withLabel, rise };
}
