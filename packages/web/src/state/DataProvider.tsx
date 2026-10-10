// One provider for the app's data world: the run index (local API first, else static files),
// every hash-verified bundle, the selected run (from ?run=), its same-cohort baseline
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
import { loadDataWorld, type DataSource } from "../data";
import { loadEvidence } from "../landing-data";
import type { z } from "zod";
import type { evidenceSchema } from "../landing-data";
import { loadCertificateWorld, type CertificateWorld } from "./certificates";
import {
  baselineCandidates,
  defaultRunId,
  groupRuns,
  pickBaseline,
  resolveDataMode,
  type DataMode,
  type RunGroup,
} from "./data-mode";

export type EvidenceEntry = z.infer<typeof evidenceSchema>[number];

export type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "missing" }
  | { status: "error"; error: string };

export type DataContextValue = {
  mode: DataMode;
  source: DataSource;
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
  certificates: Loadable<CertificateWorld>;
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
      source: DataSource;
      entries: BundleIndexEntry[];
      bundles: RunBundle[];
    };

export function DataProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [evidence, setEvidence] = useState<Loadable<EvidenceEntry[]>>({
    status: "loading",
  });
  const [certificates, setCertificates] = useState<
    Loadable<CertificateWorld>
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ status: "loading" });
    loadDataWorld(controller.signal)
      .then((world) => {
        if (!controller.signal.aborted)
          setCatalog({ status: "ready", ...world });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted)
          setCatalog({ status: "error", error: e.message });
      });
    return () => controller.abort();
  }, [reloadKey]);

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
    loadCertificateWorld(bundle.sample, bundle.runId, controller.signal)
      .then((world) => {
        if (!controller.signal.aborted)
          setCertificates(
            world ? { status: "ready", data: world } : { status: "missing" },
          );
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted)
          setCertificates({ status: "error", error: e.message });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [certKey, reloadKey]);

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

  const source: DataSource = ready?.source ?? "static";
  const value: DataContextValue = {
    mode: resolveDataMode(source, bundle),
    source,
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
    loading: catalog.status === "loading",
    error: catalog.status === "error" ? catalog.error : undefined,
    reload,
    certificates,
    evidence,
  };
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
