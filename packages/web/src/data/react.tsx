// React bindings for the data layer: one DataSourceProvider at the root (main.tsx) picks live or
// replay once per page load; components read it with useDataSource().
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { HealthResponse, IntegrationName } from "../../../core/src/schema";
import { integrationView, type IntegrationView } from "./integration";
import { replaySelection, selectDataSource, type Selection, type SelectOptions } from "./select";
import type { DataMode, DataSource } from "./types";

export type DataSourceValue = {
  source: DataSource;
  mode: DataMode;
  /** False until mode selection finished. Load nothing before it is true. */
  ready: boolean;
  /** Why live mode was refused although an API answered; null otherwise. */
  error: string | null;
  /** Live: GET /api/health at selection time. Replay: null. */
  health: HealthResponse | null;
  /** The hosted (production) build: always replay, never probed. */
  hosted: boolean;
  apiBase: string;
};

const Ctx = createContext<DataSourceValue | null>(null);

const toValue = (s: Selection, ready: boolean): DataSourceValue => ({
  source: s.source,
  mode: s.mode,
  ready,
  error: s.error,
  health: s.health,
  hosted: s.hosted,
  apiBase: s.apiBase,
});

/**
 * Selects the data source once (health probe, unless this is the hosted build) and provides it.
 * Pass `value` to inject a source (tests, storybook-like harnesses); no probe runs then.
 */
export function DataSourceProvider({
  children,
  value,
  options,
}: {
  children: ReactNode;
  value?: Partial<DataSourceValue> & { source: DataSource };
  options?: SelectOptions;
}) {
  const [state, setState] = useState<DataSourceValue>(() => {
    if (value)
      return {
        mode: value.source.mode,
        ready: true,
        error: null,
        health: null,
        hosted: false,
        apiBase: "",
        ...value,
      };
    const initial = replaySelection(options);
    // The hosted build never probes: its replay selection is final immediately.
    return toValue(initial, initial.hosted);
  });

  useEffect(() => {
    if (value || state.ready) return;
    const controller = new AbortController();
    void selectDataSource({ ...options, signal: controller.signal }).then((selection) => {
      if (!controller.signal.aborted) setState(toValue(selection, true));
    });
    return () => controller.abort();
    // Selection runs once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Ctx.Provider value={value ? { ...state, ...value } : state}>{children}</Ctx.Provider>;
}

/** The selected data source. Throws outside a DataSourceProvider. */
export function useDataSource(): DataSourceValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDataSource must be used within a DataSourceProvider.");
  return ctx;
}

/** The live server's health at selection time (null in replay). */
export function useHealth(): HealthResponse | null {
  return useDataSource().health;
}

/**
 * One integration's status for the point of use, e.g.
 *   const dodo = useIntegration("dodo");
 *   if (!dodo.connected) return <p>{dodo.message}</p>;   // "Not connected — set DODO_PAYMENTS_API_KEY in .env"
 * Never substitute a number for a missing integration.
 */
export function useIntegration(name: IntegrationName): IntegrationView {
  const { health, mode } = useDataSource();
  return useMemo(() => integrationView(health, name, mode), [health, name, mode]);
}
