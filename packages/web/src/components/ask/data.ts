// Ask Notary data hooks: the published explain.json (validated, read once per page load) and the
// run ids the local `notary serve` actually serves (free-form questions only go to those).
import { useEffect, useState } from "react";
import type { ExplainAnswer } from "../../../../core/src/schema";
import { probeLocalApi } from "../../data";
import { readOptionalJSON } from "../../optional-json";
import { useData } from "../../state/DataProvider";
import { parseExplainFile } from "./model";

export type ExplainState =
  | { status: "loading" }
  | { status: "ready"; answers: ExplainAnswer[] }
  | { status: "missing" }
  | { status: "error"; error: string };

let explainRequest: Promise<ExplainState> | undefined;

function loadExplain(): Promise<ExplainState> {
  explainRequest ??= readOptionalJSON("content/explain.json")
    .then((raw): ExplainState => {
      if (raw === undefined) return { status: "missing" };
      const parsed = parseExplainFile(raw);
      return parsed.ok ? { status: "ready", answers: parsed.data } : { status: "error", error: parsed.error };
    })
    .catch((e: Error): ExplainState => ({ status: "error", error: e.message }));
  // A failed read may be retried on the next mount.
  void explainRequest.then((s) => {
    if (s.status === "error") explainRequest = undefined;
  });
  return explainRequest;
}

export function useExplainAnswers(): ExplainState {
  const [state, setState] = useState<ExplainState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    void loadExplain().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export type LocalAskAvailability =
  | { status: "checking" }
  /** No local API (hosted site, or `notary serve` not running). */
  | { status: "offline" }
  /** The local API is up but does not serve the selected run (e.g. a static fixture file). */
  | { status: "not-served"; runId: string }
  | { status: "ready"; runId: string };

/** Whether free-form questions about the selected run can go to the local `notary serve`. */
export function useLocalAsk(): LocalAskAvailability {
  const { source, selectedRunId } = useData();
  const [served, setServed] = useState<Set<string> | null | undefined>();
  useEffect(() => {
    if (source !== "api") {
      setServed(null);
      return;
    }
    const controller = new AbortController();
    setServed(undefined);
    void probeLocalApi(controller.signal).then((entries) => {
      if (!controller.signal.aborted) setServed(entries ? new Set(entries.map((e) => e.runId)) : null);
    });
    return () => controller.abort();
  }, [source]);
  if (source !== "api" || served === null) return { status: "offline" };
  if (served === undefined || !selectedRunId) return { status: "checking" };
  return served.has(selectedRunId)
    ? { status: "ready", runId: selectedRunId }
    : { status: "not-served", runId: selectedRunId };
}
