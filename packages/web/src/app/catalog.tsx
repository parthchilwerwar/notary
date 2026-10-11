// One provider for the dashboard's data world, read through the data layer (src/data): the run
// list of the selected DataSource (live `notary serve` or replay of published files), every
// hash-verified bundle, the selected run (from ?run=), its same-cohort baseline
// (?baseline=), the certificate world matching the selected run, and the tool evidence file.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router";
import type { BundleIndexEntry, RunBundle } from "../../../core/src/schema";
import {
  byNewest,
  entryOfBundle,
  finishedEntries,
  loadEvidence,
  toCertificateView,
  useDataSource,
  type CatalogOrigin,
  type CertificateView,
  type DataSource,
  type EvidenceEntry,
  type RunEntry,
} from "../data";
import {
  baselineCandidates,
  defaultRunId,
  groupRuns,
  pickBaseline,
  resolveDataMode,
  type DataMode,
  type RunGroup,
} from "./links";

export type { EvidenceEntry };

export type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "missing" }
  | { status: "error"; error: string };

export type DataContextValue = {
  mode: DataMode;
  /** "api" = live DataSource (local `notary serve`), "static" = replay of published files. */
  source: CatalogOrigin;
  /** The data layer's source. Pages call it for anything beyond the catalog (timelines, approvals, ask). */
  dataSource: DataSource;
  /** Runs the live server reports as still running (no bundle yet). Empty in replay. */
  running: RunEntry[];
  /** Every index entry (real and fixture). Use `runGroups` to present them. */
  runs: BundleIndexEntry[];
  runGroups: RunGroup[];
  /** Every verified bundle. Never mix `sample` and real bundles in one chart or table. */
  bundles: RunBundle[];
  /** The selected run, hash-verified. Undefined while loading, on error or when nothing is published. */
  bundle?: RunBundle;
  selectedRunId?: string;
  /** ?run= named a run that is not in the catalog. */
  missingRunId?: string;
  baseline?: RunBundle;
  baselineCandidates: RunBundle[];
  setRun: (runId: string) => void;
  setBaseline: (runId: string) => void;
  loading: boolean;
  error?: string;
  reload: () => void;
  certificates: Loadable<CertificateView>;
  evidence: Loadable<EvidenceEntry[]>;
};

const DataContext = createContext<DataContextValue | null>(null);

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used within a DataProvider.");
  return ctx;
}

type CatalogState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      source: CatalogOrigin;
      entries: BundleIndexEntry[];
      running: RunEntry[];
      bundles: RunBundle[];
    };

export function DataProvider({ children }: { children: ReactNode }) {
  const { source: dataSource, mode: sourceMode, ready: sourceReady } = useDataSource();
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [evidence, setEvidence] = useState<Loadable<EvidenceEntry[]>>({
    status: "loading",
  });
  const [certificates, setCertificates] = useState<
    Loadable<CertificateView>
  >({ status: "loading" });

  useEffect(() => {
    if (!sourceReady) return;
    const controller = new AbortController();
    setCatalog({ status: "loading" });
    (async () => {
      const runs = await dataSource.listRuns(controller.signal);
      const entries = finishedEntries(runs).sort(byNewest);
      // Every bundle is schema-checked and hash-verified by the data layer before it arrives here.
      const bundles = (
        await Promise.all(entries.map((e) => dataSource.getRun(e.runId, controller.signal)))
      ).sort(byNewest);
      return {
        source: (sourceMode === "live" ? "api" : "static") as CatalogOrigin,
        entries,
        running: runs.filter((r) => r.state === "running"),
        bundles,
      };
    })()
      .then((world) => {
        if (!controller.signal.aborted)
          setCatalog({ status: "ready", ...world });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted)
          setCatalog({ status: "error", error: e.message });
      });
    return () => controller.abort();
  }, [reloadKey, dataSource, sourceMode, sourceReady]);

  useEffect(() => {
    const controller = new AbortController();
    setEvidence({ status: "loading" });
    loadEvidence(controller.signal)
      .then((entries) => {
        if (!controller.signal.aborted)
          setEvidence(
            entries.length
              ? { status: "ready", data: entries }
              : { status: "missing" },
          );
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted)
          setEvidence({ status: "error", error: e.message });
      });
    return () => controller.abort();
  }, [reloadKey]);

  const requested = params.get("run");
  const ready = catalog.status === "ready" ? catalog : undefined;
  const bundles = useMemo(() => ready?.bundles ?? [], [ready]);
  const entries = useMemo(() => ready?.entries ?? [], [ready]);
  const fallbackId = useMemo(() => defaultRunId(entries), [entries]);
  const bundle = requested
    ? bundles.find((b) => b.runId === requested)
    : bundles.find((b) => b.runId === fallbackId);
  const missingRunId =
    ready && requested && !bundle ? requested : undefined;

  // Keep the selected run in the URL so every page is shareable as-is.
  useEffect(() => {
    if (ready && !requested && fallbackId)
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set("run", fallbackId);
          return next;
        },
        { replace: true },
      );
  }, [ready, requested, fallbackId, setParams]);

  const certKey = bundle ? `${bundle.sample}:${bundle.runId}` : "";
  useEffect(() => {
    if (!bundle) {
      setCertificates({ status: "missing" });
      return;
    }
    const controller = new AbortController();
    setCertificates({ status: "loading" });
    dataSource
      .certificates(entryOfBundle(bundle), controller.signal)
      .then((world) => {
        if (controller.signal.aborted) return;
        const view = toCertificateView(world);
        setCertificates(view ? { status: "ready", data: view } : { status: "missing" });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted)
          setCertificates({ status: "error", error: e.message });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [certKey, reloadKey, dataSource]);

  const setRun = useCallback(
    (runId: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set("run", runId);
        next.delete("baseline");
        return next;
      }),
    [setParams],
  );
  const setBaseline = useCallback(
    (runId: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set("baseline", runId);
        return next;
      }),
    [setParams],
  );
  const reload = useCallback(() => setReloadKey((v) => v + 1), []);

  const source: CatalogOrigin = ready?.source ?? (sourceMode === "live" ? "api" : "static");
  const value: DataContextValue = {
    mode: resolveDataMode(source, bundle),
    source,
    dataSource,
    running: ready?.running ?? [],
    runs: entries,
    runGroups: groupRuns(entries, source),
    bundles,
    bundle,
    selectedRunId: bundle?.runId ?? requested ?? fallbackId,
    missingRunId,
    baseline: pickBaseline(bundle, bundles, params.get("baseline")),
    baselineCandidates: baselineCandidates(bundle, bundles),
    setRun,
    setBaseline,
    loading: !sourceReady || catalog.status === "loading",
    error: catalog.status === "error" ? catalog.error : undefined,
    reload,
    certificates,
    evidence,
  };
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
