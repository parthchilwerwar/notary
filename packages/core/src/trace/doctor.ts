/**
 * `notary doctor`: emit one smoke span to neatlogs and report what happened.
 * The CLI is responsible for loading .env before calling runDoctor().
 */
import { flushTracingDetailed, initTracing, withSpan, type SpanIds, type TracingState } from "./index.js";

export type DoctorReport = {
  tracing: TracingState;
  spanEmitted: boolean;
  spanId?: string;
  traceId?: string;
  notes: string[];
};

export async function runDoctor(): Promise<DoctorReport> {
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
  if (ids && flushed) notes.push(`span "notary.doctor" flushed; search neatlogs for trace ${ids.traceId}`);

  return {
    tracing,
    spanEmitted: Boolean(ids) && flushed,
    ...(ids ? { spanId: ids.spanId, traceId: ids.traceId } : {}),
    notes,
  };
}
