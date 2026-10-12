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
import { readBackTrace } from "./readback.js";
import type { TraceReadBack } from "./readback.js";
import { flushTracingDetailed, initTracing, neatlogsSdkVersion, withSpan, type SpanIds, type TracingState } from "./index.js";

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

/** What the SDK, export and read-back look like (never a key value: only set / not set). */
export type NeatlogsSetup = {
  /** The installed neatlogs SDK version (its __version__ export), or null when it can't be loaded. */
  sdkVersion: string | null;
  /** "on" when spans are exported to neatlogs (NEATLOGS_API_KEY set, NEATLOGS_DISABLE_EXPORT not set). */
  export: "on" | "off";
  exportReason?: string;
  /** NEATLOGS_SERVICE_TOKEN: a service-account token, needed to read traces back with neatlogs-cli (FR-10). */
  serviceToken: "set" | "not set";
  /** How to read traces back. */
  readBackHint: string;
};

const CLI_HINT =
  "neatlogs-cli is not a dependency (nothing is installed globally). To read traces back, run it on demand with " +
  "`pnpm dlx neatlogs-cli@<version> traces get <traceId> --json` (or npx -y) with NEATLOGS_TOKEN=<service-account token>, " +
  "NEATLOGS_PROJECT_ID=<project uuid> and NEATLOGS_HOST=https://app.neatlogs.com in its environment: the CLI reads NEATLOGS_TOKEN, not NEATLOGS_SERVICE_TOKEN. " +
  "Without it, `notary doctor` reads the last doctor trace back with the project key (GET /api/traces/v3/<traceId>, the SDK probe's route) and FR-10 evidence reads runs/<runId>/spans.jsonl (DECISIONS #48).";

/** SDK version, export on/off and the read-back credential, from the environment. Never returns a secret. */
export async function neatlogsSetup(env: NodeJS.ProcessEnv = process.env, tracing?: TracingState): Promise<NeatlogsSetup> {
  const key = (env.NEATLOGS_API_KEY ?? "").trim().length > 0;
  const disabled = ["true", "1", "yes"].includes((env.NEATLOGS_DISABLE_EXPORT ?? "").trim().toLowerCase());
  const on = tracing ? tracing.enabled : key && !disabled;
  const token = (env.NEATLOGS_SERVICE_TOKEN ?? env.NEATLOGS_TOKEN ?? "").trim().length > 0;
  const reason = tracing && !tracing.enabled ? tracing.reason : !key ? "NEATLOGS_API_KEY not set" : disabled ? "NEATLOGS_DISABLE_EXPORT is set" : undefined;
  return {
    sdkVersion: (await neatlogsSdkVersion()) ?? null,
    export: on ? "on" : "off",
    ...(on || !reason ? {} : { exportReason: reason }),
    serviceToken: token ? "set" : "not set",
    readBackHint: token ? `service token set. ${CLI_HINT}` : `NEATLOGS_SERVICE_TOKEN is empty: create a service account in neatlogs Settings -> Service Accounts (scope trace:read). ${CLI_HINT}`,
  };
}

export type DoctorReport = {
  tracing: TracingState;
  neatlogs?: NeatlogsSetup;
  /** With readBack: the previously recorded doctor trace read back from neatlogs (counts only). */
  readBack?: TraceReadBack;
  spanEmitted: boolean;
  spanId?: string;
  traceId?: string;
  notes: string[];
};

/** `recordPath: null` skips recording the success (tests); default is config/neatlogs-doctor.json. */
export async function runDoctor(opts: { recordPath?: string | null; now?: () => Date; readBack?: boolean } = {}): Promise<DoctorReport> {
  const notes: string[] = [];
  // Read back the LAST recorded doctor trace (a fresh one needs a few seconds to be persisted).
  let readBack: TraceReadBack | undefined;
  if (opts.readBack) {
    const prev = opts.recordPath === null ? undefined : readDoctorRecord(opts.recordPath ?? DOCTOR_RECORD_PATH);
    if (prev) {
      readBack = await readBackTrace(prev.traceId);
      notes.push(readBack.status === "ok" ? `read back trace ${prev.traceId} from neatlogs: ${readBack.spanCount} span(s), status ${readBack.traceStatus}` : `read-back of ${prev.traceId}: ${readBack.status} (${readBack.detail})`);
    }
  }
  const tracing = await initTracing({ serviceName: "doctor" });
  const neatlogs = await neatlogsSetup(process.env, tracing);
  notes.push(`neatlogs SDK ${neatlogs.sdkVersion ?? "not loadable"}; export ${neatlogs.export}; NEATLOGS_SERVICE_TOKEN ${neatlogs.serviceToken}`);

  if (!tracing.enabled) {
    notes.push(`tracing disabled: ${tracing.reason ?? "unknown reason"}; no span sent`);
    return { tracing, neatlogs, ...(readBack ? { readBack } : {}), spanEmitted: false, notes };
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
    return { tracing, neatlogs, ...(readBack ? { readBack } : {}), spanEmitted: false, notes };
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
    neatlogs,
    ...(readBack ? { readBack } : {}),
    spanEmitted: Boolean(ids) && flushed,
    ...(ids ? { spanId: ids.spanId, traceId: ids.traceId } : {}),
    notes,
  };
}
