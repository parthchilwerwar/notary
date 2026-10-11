// THE route table for /app. Sidebar, top bar title, document titles, the command palette and the
// router all read it. Four pages are in the sidebar (Run, Certificates, Approvals, Ask); Report is
// linked from the sidebar footer; a certificate has its own page.
import type { ReactElement } from "react";
import { matchPath } from "react-router";
import { RunPage } from "./pages/run/RunPage";
import { CertificatesPage } from "./pages/certificates/CertificatesPage";
import { CertificateDetailPage } from "./pages/certificates/CertificateDetailPage";
import { ApprovalsPage } from "./pages/approvals";
import { AskPage } from "./components/ask/AskPage";
import { ReportPage } from "./pages/report/ReportPage";

export type AppRoute = {
  id: string;
  /** Absolute path under /app; `:param` segments name the record. */
  path: string;
  title: string;
  description: string;
  /** In the sidebar (exactly four routes). */
  nav?: boolean;
  /** Sidebar count: approvals waiting for a human. */
  badge?: "approvals";
  /** Route id of the list page a record belongs to (top bar trail; switching runs returns there). */
  parent?: string;
  /** Record kind this route renders, for routes with a `:param`. */
  record?: "certificate";
  /** Renders without a selected, verified run (it handles empty and loading states itself). */
  ungated?: boolean;
  element: ReactElement;
};

export const routes: AppRoute[] = [
  { id: "run", path: "/app/run", title: "Run", description: "One run, step by step: what the agent did and why.", nav: true, ungated: true, element: <RunPage /> },
  { id: "certificates", path: "/app/certificates", title: "Certificates", description: "API behavior certified within a scope, and revocable.", nav: true, element: <CertificatesPage /> },
  { id: "certificate", path: "/app/certificates/:certificateId", title: "Certificate", description: "One certificate and the evidence behind it.", parent: "certificates", record: "certificate", element: <CertificateDetailPage /> },
  { id: "approvals", path: "/app/approvals", title: "Approvals", description: "Held money actions waiting for a human.", nav: true, badge: "approvals", element: <ApprovalsPage /> },
  { id: "ask", path: "/app/ask", title: "Ask", description: "Answers from records, with citations.", nav: true, element: <AskPage /> },
  { id: "report", path: "/app/report", title: "Report", description: "Run comparison, cost per run, connections and receipts.", ungated: true, element: <ReportPage /> },
];

/** The sidebar, in order. */
export const navRoutes = () => routes.filter((r) => r.nav);

export type Redirect = {
  from: string;
  /** Target path (may carry a query); `:param` values of `from` are substituted. */
  to: string;
};

/**
 * Old URLs, kept working for shared links. The old query string is kept and merged with the
 * target's (the target's own params win, e.g. ?run= of /app/runs/:runId).
 */
export const redirects: Redirect[] = [
  { from: "/app", to: "/app/run" },
  { from: "/app/overview", to: "/app/run" },
  { from: "/app/mission-control", to: "/app/run" },
  { from: "/app/runs", to: "/app/run" },
  { from: "/app/runs/:runId", to: "/app/run?run=:runId" },
  { from: "/app/queue", to: "/app/run" },
  { from: "/app/queue/:decisionId", to: "/app/run?decision=:decisionId" },
  { from: "/app/probes", to: "/app/run" },
  { from: "/app/probes/:probeId", to: "/app/run?probe=:probeId" },
  { from: "/app/beliefs", to: "/app/certificates" },
  { from: "/app/beliefs/:beliefId", to: "/app/certificates?belief=:beliefId" },
  { from: "/app/reports", to: "/app/certificates" },
  { from: "/app/reports/:tool", to: "/app/certificates?tool=:tool" },
  { from: "/app/api-report", to: "/app/certificates" },
  { from: "/app/revocation-demo", to: "/app/certificates" },
  { from: "/app/revocation", to: "/app/certificates" },
  { from: "/app/economics", to: "/app/report" },
  { from: "/app/evidence", to: "/app/report" },
  { from: "/app/comparison", to: "/app/report" },
];

/** The target of a redirect for concrete params, old query merged (target params win). */
export function redirectTarget(r: Redirect, params: Record<string, string | undefined>, search = ""): string {
  const filled = r.to.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ""));
  const [path, query = ""] = filled.split("?", 2) as [string, string?];
  const merged = new URLSearchParams(search);
  for (const [k, v] of new URLSearchParams(query)) merged.set(k, v);
  const q = merged.toString();
  return q ? `${path}?${q}` : path;
}

export const routeById = (id: string) => routes.find((r) => r.id === id);

/** The route (and its params) for a pathname. Most specific match wins. */
export function matchAppRoute(
  pathname: string,
): { route: AppRoute; params: Record<string, string | undefined> } | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const route of [...routes].sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
    const m = matchPath({ path: route.path, end: true }, normalized);
    if (m) return { route, params: m.params };
  }
  return undefined;
}

/** Path relative to the /app/* splat, for <Route path>. */
export const relativePath = (path: string) => (path === "/app" ? "" : path.replace(/^\/app\//, ""));
