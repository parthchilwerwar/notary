// Ask Notary data hooks, through the data layer: the precomputed explain answers
// (DataSource.explain, schema-checked there) and the run ids the live `notary serve` actually
// serves (free-form questions only go to those).
import { useEffect, useState } from "react";
import type { ExplainAnswer } from "../../../../core/src/schema";
import { LiveSource, type DataSource } from "../../data";
import { useData } from "../../app/catalog";

export type ExplainState =
  | { status: "loading" }
  | { status: "ready"; answers: ExplainAnswer[] }
  | { status: "missing" }
  | { status: "error"; error: string };

// One read per data source per page load; a failed read may be retried on the next mount.
const explainRequests = new WeakMap<DataSource, Promise<ExplainState>>();

function loadExplain(source: DataSource): Promise<ExplainState> {
  let request = explainRequests.get(source);
  if (!request) {
    request = source
      .explain()
      .then((file): ExplainState => (file ? { status: "ready", answers: file.answers } : { status: "missing" }))
      .catch((e: Error): ExplainState => ({ status: "error", error: e.message }));
    explainRequests.set(source, request);
    void request.then((s) => {
      if (s.status === "error") explainRequests.delete(source);
    });
  }
  return request;
}

export function useExplainAnswers(): ExplainState {
  const { dataSource } = useData();
  const [state, setState] = useState<ExplainState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    void loadExplain(dataSource).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [dataSource]);
  return state;
}

export type LocalAskAvailability =
  | { status: "checking" }
  /** No local API (hosted site, or `notary serve` not running). */
  | { status: "offline" }
  /** The local API is up but does not serve the selected run (e.g. a published fixture file). */
  | { status: "not-served"; runId: string }
  | { status: "ready"; runId: string };

/** Whether free-form questions about the selected run can go to the local `notary serve`. */
export function useLocalAsk(): LocalAskAvailability {
  const { dataSource, selectedRunId } = useData();
  const [served, setServed] = useState<Set<string> | null | undefined>();
  useEffect(() => {
    if (!(dataSource instanceof LiveSource)) {
      setServed(null);
      return;
    }
    const controller = new AbortController();
    setServed(undefined);
    dataSource
      .servedRuns(controller.signal)
      .then((runs) => {
        if (!controller.signal.aborted) setServed(new Set(runs.map((r) => r.runId)));
      })
      .catch(() => {
        if (!controller.signal.aborted) setServed(null);
      });
    return () => controller.abort();
  }, [dataSource]);
  if (!(dataSource instanceof LiveSource) || served === null) return { status: "offline" };
  if (served === undefined || !selectedRunId) return { status: "checking" };
  return served.has(selectedRunId)
    ? { status: "ready", runId: selectedRunId }
    : { status: "not-served", runId: selectedRunId };
}
