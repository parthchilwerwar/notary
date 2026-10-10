/**
 * `notary doctor`: emit one smoke span to neatlogs and report what happened.
 * The CLI is responsible for loading .env before calling runDoctor().
 *
 * On success the report is also recorded in packages/core/config/neatlogs-doctor.json (commit-safe:
 * trace id, span id, timestamp, nothing else). `notary export --evidence` reads that file to decide
 * whether neatlogs is "live". A failed run never overwrites the last success.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { flushTracingDetailed, initTracing, withSpan, type SpanIds, type TracingState } from "./index.js";

export const DOCTOR_RECORD_PATH = fileURLToPath(new URL("../../config/neatlogs-doctor.json", import.meta.url));

/** Last successful `notary doctor` run. `flushedAt` is an ISO datetime, or an ISO date for a seeded record. */
export const DoctorRecordSchema = z
  .object({
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
    spanId: z.string().regex(/^[0-9a-f]{16}$/),
    flushedAt: z.union([z.iso.datetime(), z.iso.date()]),
    source: z.string().min(1),
  })
  .strict();
export type DoctorRecord = z.infer<typeof DoctorRecordSchema>;

export function readDoctorRecord(path: string = DOCTOR_RECORD_PATH): DoctorRecord | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = DoctorRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.success ? parsed.data : undefined;
}

export function writeDoctorRecord(rec: DoctorRecord, path: string = DOCTOR_RECORD_PATH): void {
  const clean = DoctorRecordSchema.parse(rec);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
}

export type DoctorReport = {
  tracing: TracingState;
  spanEmitted: boolean;
  spanId?: string;
  traceId?: string;
  notes: string[];
};

/** `recordPath: null` skips recording the success (tests); default is config/neatlogs-doctor.json. */
export async function runDoctor(opts: { recordPath?: string | null; now?: () => Date } = {}): Promise<DoctorReport> {
  const notes: string[] = [];
  const tracing = await initTracing({ serviceName: "doctor" });

  if (!tracing.enabled) {
    notes.push(`tracing disabled: ${tracing.reason ?? "unknown reason"}; no span sent`);
    return { tracing, spanEmitted: false, notes };
  }

  let ids: SpanIds | undefined;
  try {
    await withSpan(
      "notary.doctor",
      { "notary.check": "smoke", "notary.timestamp": new Date().toISOString() },
      () => "ok",
      { onSpan: (spanIds) => (ids = spanIds) },
    );
  } catch (err) {
    notes.push(`span failed: ${err instanceof Error ? err.message : String(err)}`);
    return { tracing, spanEmitted: false, notes };
  }

  const flushed = await flushTracingDetailed();
  if (!ids) notes.push("span was not created by the SDK");
  if (!flushed) notes.push("neatlogs flush reported a failure (check the API key and network)");
  if (ids && flushed) {
    notes.push(`span "notary.doctor" flushed; search neatlogs for trace ${ids.traceId}`);
    const recordPath = opts.recordPath === undefined ? DOCTOR_RECORD_PATH : opts.recordPath;
    if (recordPath) {
      try {
        const flushedAt = (opts.now ?? (() => new Date()))().toISOString();
        writeDoctorRecord({ traceId: ids.traceId, spanId: ids.spanId, flushedAt, source: "notary doctor" }, recordPath);
        notes.push(`recorded in ${recordPath}`);
      } catch (err) {
        notes.push(`could not record the success: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    tracing,
    spanEmitted: Boolean(ids) && flushed,
    ...(ids ? { spanId: ids.spanId, traceId: ids.traceId } : {}),
    notes,
  };
}
