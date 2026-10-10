/**
 * Writing the v2 run timeline (Node side of src/timeline/derive.ts).
 *
 *   recordRunTimeline   after a bundle is written to runs/<runId>/: (re)write runs/<runId>/timeline.jsonl
 *                       with the derived events (seq 0..n-1), then every `approval.decided` event the
 *                       approval desk appended earlier, re-sequenced after them; emit the derived events
 *                       on the bus as `timeline` events. The file is the source of truth.
 *   publishTimeline     write <dir>/<runId>.timeline.json (a TimelineFile) next to a published bundle.
 *   liveTimeline        best-effort `timeline` bus events while a run is in progress (data.live = true,
 *                       provisional seq from a per-run counter; superseded by the file).
 *
 * Context for certificate ids (derive.ts): the other verified bundles in the same runs dir
 * (runs/<dir>/<dir>.json) with the same `sample` flag that started no later than this one. Loaded
 * only when the bundle has a revocation whose notarization is not in the bundle itself.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emitEvent } from "../api/bus.js";
import { leakedSecretNames, verifyBundle } from "../bundle/index.js";
import type { Decision, QueueRequest, RunBundle } from "../schema/index.js";
import { TimelineEventSchema, TimelineFileSchema } from "../schema/timeline.js";
import type { TimelineEvent, TimelineFile } from "../schema/timeline.js";
import { deriveTimeline, liveDecisionEvent } from "./derive.js";
import type { DerivedTimelineEvent } from "./derive.js";
import { readTimeline, timelinePath } from "./store.js";

/** Published file name next to `<runId>.json`. */
export const TIMELINE_FILE_SUFFIX = ".timeline.json";

export function publishedTimelineName(runId: string): string {
  return `${runId}${TIMELINE_FILE_SUFFIX}`;
}

/** True when some notarized → * event has no → notarized event for the same belief earlier in the bundle. */
export function needsCertificateContext(bundle: RunBundle): boolean {
  const notarized = new Set<string>();
  for (const e of bundle.beliefEvents) {
    if (e.to === "notarized" && e.from !== "notarized") notarized.add(e.beliefId);
    if (e.from === "notarized" && e.to !== "notarized" && !notarized.has(e.beliefId)) return true;
  }
  return false;
}

/** Verified bundles in `runsDir/<dir>/<dir>.json` of the same world as `bundle` (sample flag), started no later. */
export function loadContextBundles(runsDir: string, bundle: RunBundle): RunBundle[] {
  if (!existsSync(runsDir)) return [];
  const out: RunBundle[] = [];
  for (const name of readdirSync(runsDir).sort()) {
    if (name === bundle.runId) continue;
    const file = join(runsDir, name, `${name}.json`);
    try {
      if (!statSync(join(runsDir, name)).isDirectory() || !existsSync(file)) continue;
      const v = verifyBundle(JSON.parse(readFileSync(file, "utf8")));
      if (!v.ok || v.bundle.runId !== name || v.bundle.sample !== bundle.sample) continue;
      if (Date.parse(v.bundle.startedAt) > Date.parse(bundle.startedAt)) continue;
      out.push(v.bundle);
    } catch {
      // unreadable: not context
    }
  }
  return out;
}

function sequence(events: readonly (DerivedTimelineEvent | TimelineEvent)[]): TimelineEvent[] {
  return events.map((e, seq) => {
    const { seq: _old, ...rest } = e as TimelineEvent;
    return TimelineEventSchema.parse({ ...rest, seq });
  });
}

/** Derived events + the run dir's earlier `approval.decided` events, sequenced (what timeline.jsonl holds). */
export function timelineEvents(bundle: RunBundle, opts: { runDir?: string; context?: readonly RunBundle[] } = {}): TimelineEvent[] {
  const derived = deriveTimeline(bundle, { context: opts.context ?? [] });
  const approvals = opts.runDir ? readTimeline(opts.runDir).filter((e) => e.type === "approval.decided" && e.runId === bundle.runId) : [];
  return sequence([...derived, ...approvals]);
}

export interface RecordTimelineOptions {
  /** The runs dir that holds runDir (for context bundles). Default: dirname(runDir). */
  runsDir?: string;
  /** Explicit context (skips loading from runsDir). */
  context?: readonly RunBundle[];
  /** Emit the derived events on the bus (default true). */
  emit?: boolean;
}

/** (Re)write runs/<runId>/timeline.jsonl for `bundle`; returns the events written. */
export function recordRunTimeline(bundle: RunBundle, runDir: string, opts: RecordTimelineOptions = {}): TimelineEvent[] {
  const context = opts.context ?? (needsCertificateContext(bundle) ? loadContextBundles(opts.runsDir ?? dirname(runDir), bundle) : []);
  const events = timelineEvents(bundle, { runDir, context });
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const leaked = leakedSecretNames(text);
  if (leaked.length) throw new Error(`refusing to write timeline for ${bundle.runId}: it contains the value of secret env var(s) ${leaked.join(", ")}`);
  mkdirSync(runDir, { recursive: true });
  // Write-then-rename so a reader (or the approval desk) never sees a half-written file.
  const path = timelinePath(runDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
  if (opts.emit !== false) {
    for (const e of events) if (e.type !== "approval.decided") emitEvent("timeline", e);
  }
  return events;
}

/** The published TimelineFile for `bundle` (sample flag and bundleHash taken from the bundle). */
export function buildTimelineFile(bundle: RunBundle, opts: { runDir?: string; context?: readonly RunBundle[] } = {}): TimelineFile {
  return TimelineFileSchema.parse({
    runId: bundle.runId,
    sample: bundle.sample,
    bundleHash: bundle.contentHash,
    events: timelineEvents(bundle, opts),
  });
}

/**
 * Write `<dir>/<runId>.timeline.json` next to a published bundle. Refuses a bundle that fails
 * verification, a sample/real mismatch with `expectSample`, or text containing a secret env value.
 */
export async function publishTimeline(
  bundle: RunBundle,
  dir: string,
  opts: { expectSample: boolean; runDir?: string; runsDir?: string; context?: readonly RunBundle[] },
): Promise<string> {
  const v = verifyBundle(bundle);
  if (!v.ok) throw new Error(`refusing to publish timeline: ${v.error}`);
  if (v.bundle.sample !== opts.expectSample) {
    throw new Error(`refusing to publish timeline for ${v.bundle.runId}: sample is ${v.bundle.sample}, expected ${opts.expectSample} (fixture and real data never mix)`);
  }
  const context = opts.context ?? (opts.runsDir && needsCertificateContext(v.bundle) ? loadContextBundles(opts.runsDir, v.bundle) : []);
  const file = buildTimelineFile(v.bundle, { ...(opts.runDir && existsSync(opts.runDir) ? { runDir: opts.runDir } : {}), context });
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const leaked = leakedSecretNames(text);
  if (leaked.length) throw new Error(`refusing to publish timeline for ${v.bundle.runId}: it contains the value of secret env var(s) ${leaked.join(", ")}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, publishedTimelineName(v.bundle.runId));
  await writeFile(path, text, "utf8");
  return path;
}

/** Live best-effort emitter for one run: assigns a provisional per-run seq and marks data.live. */
export function liveTimeline(runId: string): (event: DerivedTimelineEvent) => void {
  let seq = 0;
  return (event) => {
    try {
      const e = TimelineEventSchema.parse({ ...event, runId, seq: seq++, data: { ...(event.data ?? {}), live: true } });
      emitEvent("timeline", e);
    } catch {
      // Live view is best-effort; never break a run.
    }
  };
}

/** Live `timeline` events for a queue run's decisions as the executor reports them (best-effort). */
export function liveDecisionEmitter(runId: string, queue: readonly QueueRequest[], now: () => Date): (d: Decision) => void {
  const emit = liveTimeline(runId);
  return (d) => {
    try {
      emit(liveDecisionEvent(runId, d, queue.find((q) => q.id === d.requestId), now().toISOString()));
    } catch {
      // best-effort
    }
  };
}
