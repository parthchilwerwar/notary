// Shell-wide live status, read through the data layer:
//  - the local server's health, re-checked every 30 s and when the tab regains focus (live mode
//    only). The selection-time check alone could keep saying "Live" after `notary serve` stopped.
//  - the number of approvals waiting, from DataSource.approvals() (live: needs the session token;
//    replay: held decisions of the recorded runs). Undefined while unknown, never a placeholder 0.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { HealthResponse } from "../../../../core/src/schema";
import { useDataSource, useSessionToken } from "../../data";

export const RECHECK_MS = 30_000;

export type LiveHealth =
  | { state: "replay" }
  | { state: "checking"; health: HealthResponse | null }
  | { state: "ok"; health: HealthResponse; checkedAt: string }
  | { state: "unreachable"; health: HealthResponse | null; checkedAt: string; error: string };

export type ApprovalsCount =
  | { state: "unknown"; reason: string }
  | { state: "ready"; pending: number; readOnly: boolean };

type ShellStatus = {
  health: LiveHealth;
  recheckHealth: () => void;
  approvals: ApprovalsCount;
  refreshApprovals: () => void;
};

const Ctx = createContext<ShellStatus | null>(null);

export function useShellStatus(): ShellStatus {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useShellStatus must be used within a ShellStatusProvider.");
  return ctx;
}

/** The shell status when rendered inside the shell; undefined in isolated renders (tests). */
export function useOptionalShellStatus(): ShellStatus | undefined {
  return useContext(Ctx) ?? undefined;
}

export function ShellStatusProvider({ children }: { children: ReactNode }) {
  const { source, mode, ready, health: selected } = useDataSource();
  const [token] = useSessionToken();
  const [health, setHealth] = useState<LiveHealth>(() =>
    mode === "live" ? { state: "checking", health: selected } : { state: "replay" },
  );
  const [healthKey, setHealthKey] = useState(0);
  const [approvals, setApprovals] = useState<ApprovalsCount>({ state: "unknown", reason: "Loading…" });
  const [approvalsKey, setApprovalsKey] = useState(0);

  useEffect(() => {
    if (!ready) return;
    if (mode !== "live") {
      setHealth({ state: "replay" });
      return;
    }
    const controller = new AbortController();
    setHealth((h) => (h.state === "ok" || h.state === "unreachable" ? h : { state: "checking", health: selected }));
    source
      .health(controller.signal)
      .then((h) => {
        if (controller.signal.aborted) return;
        if (h) setHealth({ state: "ok", health: h, checkedAt: new Date().toISOString() });
      })
      .catch((e: Error) => {
        if (controller.signal.aborted) return;
        setHealth((prev) => ({
          state: "unreachable",
          health: prev.state === "replay" ? null : prev.health,
          checkedAt: new Date().toISOString(),
          error: e.message,
        }));
      });
    return () => controller.abort();
  }, [source, mode, ready, selected, healthKey]);

  // Re-check on a timer and on focus, live mode only.
  useEffect(() => {
    if (!ready || mode !== "live") return;
    const recheck = () => setHealthKey((k) => k + 1);
    const timer = window.setInterval(recheck, RECHECK_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible") recheck();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [ready, mode]);

  useEffect(() => {
    if (!ready) return;
    if (mode === "live" && !token) {
      setApprovals({ state: "unknown", reason: "Paste the session token on the Approvals page to see waiting items." });
      return;
    }
    const controller = new AbortController();
    source
      .approvals(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted)
          setApprovals({ state: "ready", pending: list.pending.length, readOnly: mode !== "live" });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setApprovals({ state: "unknown", reason: e.message });
      });
    return () => controller.abort();
  }, [source, mode, ready, token, approvalsKey]);

  // Live mode: waiting items change as runs hold actions; refresh with the health re-check.
  useEffect(() => {
    if (mode === "live" && healthKey > 0) setApprovalsKey((k) => k + 1);
  }, [mode, healthKey]);

  const recheckHealth = useCallback(() => setHealthKey((k) => k + 1), []);
  const refreshApprovals = useCallback(() => setApprovalsKey((k) => k + 1), []);
  const value = useMemo(
    () => ({ health, recheckHealth, approvals, refreshApprovals }),
    [health, recheckHealth, approvals, refreshApprovals],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The health to show: the latest re-check, else the selection-time response. */
export function latestHealth(h: LiveHealth): HealthResponse | null {
  return h.state === "replay" ? null : h.health;
}

/** Sidebar footer wording for the data mode. */
export function modeLabel(h: LiveHealth): { text: string; detail?: string; tone: "neutral" | "unsafe" } {
  switch (h.state) {
    case "replay":
      return { text: "Replay", tone: "neutral" };
    case "checking":
    case "ok":
      return { text: "Live", tone: "neutral" };
    case "unreachable":
      return { text: "Live", detail: "server not responding", tone: "unsafe" };
  }
}
