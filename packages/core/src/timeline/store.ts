// runs/<runId>/timeline.jsonl: append-only, one TimelineEvent per line, `seq` strictly increasing.
// Shared by the timeline deriver (end of a run) and the approval desk (after a run).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TimelineEventSchema } from "../schema/timeline.js";
import type { TimelineEvent } from "../schema/timeline.js";

export const TIMELINE_FILE = "timeline.jsonl";

export function timelinePath(runDir: string): string {
  return join(runDir, TIMELINE_FILE);
}

/** Every event in runs/<runId>/timeline.jsonl, validated, in file order. [] when absent. */
export function readTimeline(runDir: string): TimelineEvent[] {
  const path = timelinePath(runDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      const parsed = TimelineEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${path}:${i + 1}: not a timeline event (${parsed.error.issues[0]?.message ?? "invalid"})`);
      return parsed.data;
    });
}

/** Append events after the file's last seq; returns them with their assigned seq. */
export function appendTimelineEvents(runDir: string, events: readonly Omit<TimelineEvent, "seq">[]): TimelineEvent[] {
  const existing = readTimeline(runDir);
  let seq = existing.length ? existing[existing.length - 1]!.seq + 1 : 0;
  const out = events.map((e) => TimelineEventSchema.parse({ ...e, seq: seq++ }));
  if (!out.length) return out;
  mkdirSync(runDir, { recursive: true });
  appendFileSync(timelinePath(runDir), out.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return out;
}
