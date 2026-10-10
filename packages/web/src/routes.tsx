// THE route table for /app. Sidebar, breadcrumbs, document titles, the command palette and the
// router all read it. To build a page in a later phase, replace its `element` here; to add a
// page, add a row (and a `group` if it belongs in the sidebar).
import { AskPage } from "./components/ask/AskPage";
import { MissionControlPage } from "./pages/mission-control/MissionControlPage";
import type { ComponentType, ReactElement } from "react";
import { matchPath } from "react-router";
import { SquaresFourIcon as SquaresFour } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { CrosshairIcon as Crosshair } from "@phosphor-icons/react/dist/csr/Crosshair";
import { StackIcon as Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { FlaskIcon as Flask } from "@phosphor-icons/react/dist/csr/Flask";
import { CertificateIcon as Certificate } from "@phosphor-icons/react/dist/csr/Certificate";
import { FileTextIcon as FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { QueueIcon as QueueGlyph } from "@phosphor-icons/react/dist/csr/Queue";
import { StampIcon as Stamp } from "@phosphor-icons/react/dist/csr/Stamp";
import { ChatCircleTextIcon as ChatCircleText } from "@phosphor-icons/react/dist/csr/ChatCircleText";
import { CurrencyDollarIcon as CurrencyDollar } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { ReceiptIcon as Receipt } from "@phosphor-icons/react/dist/csr/Receipt";
import { ScalesIcon as Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { ProhibitIcon as Prohibit } from "@phosphor-icons/react/dist/csr/Prohibit";
import {
  OverviewPage,
  ProbeDetailPage,
  ProbesPage,
  RunDetailPage,
  RunsPage,
} from "./pages/monitor";
import {
  BeliefDetailPage,
  BeliefsPage,
  CertificateDetailPage,
  CertificatesPage,
  ReportDetailPage,
  ReportsPage,
  RevocationDemoPage,
} from "./pages/trust";
import {
  ApprovalsPage,
  DecisionDetailPage,
  QueuePage,
} from "./pages/act";
import { EconomicsPage, EvidencePage } from "./pages/business";

export type NavGroup = "Monitor" | "Trust" | "Act" | "Business";
export const NAV_GROUPS: NavGroup[] = ["Monitor", "Trust", "Act", "Business"];

export type AppIcon = ComponentType<{ size?: number | string; className?: string }>;

export type AppRoute = {
  id: string;
  /** Absolute path under /app; `:param` segments name the record. */
  path: string;
  title: string;
  description: string;
  icon: AppIcon;
  /** Sidebar group. Only list pages have one; record pages set `parent` instead. */
  group?: NavGroup;
  /** Sidebar badge: held decisions of the selected run, or revocations of its certificate world. */
  badge?: "held" | "revocations";
  /** Route id of the list page a record belongs to (breadcrumbs; switching runs returns there). */
  parent?: string;
  /** Record kind this route renders, for routes with a `:param`. */
  record?: "decision" | "probe" | "belief" | "certificate" | "run" | "report";
  element: ReactElement;
};

export const routes: AppRoute[] = [
  // Monitor
  { id: "overview", path: "/app", title: "Overview", description: "Money, decisions and trust for the selected run.", icon: SquaresFour, group: "Monitor", element: <OverviewPage /> },
  { id: "mission-control", path: "/app/mission-control", title: "Mission control", description: "Where the selected run stands, stage by stage.", icon: Crosshair, group: "Monitor", element: <MissionControlPage /> },
  { id: "runs", path: "/app/runs", title: "Runs", description: "Every published run, and comparisons within one cohort.", icon: Stack, group: "Monitor", element: <RunsPage /> },
  { id: "run", path: "/app/runs/:runId", title: "Run", description: "One run's provenance and counts.", icon: Stack, parent: "runs", record: "run", element: <RunDetailPage /> },
  { id: "probes", path: "/app/probes", title: "Probe log", description: "Predictions first. Observations second.", icon: Flask, group: "Monitor", element: <ProbesPage /> },
  { id: "probe", path: "/app/probes/:probeId", title: "Probe", description: "One committed experiment.", icon: Flask, parent: "probes", record: "probe", element: <ProbeDetailPage /> },
  // Trust
  { id: "certificates", path: "/app/certificates", title: "Certificates", description: "API behavior, certified within a scope. Revocable.", icon: Certificate, group: "Trust", badge: "revocations", element: <CertificatesPage /> },
  { id: "certificate", path: "/app/certificates/:certificateId", title: "Certificate", description: "One certificate and its evidence.", icon: Certificate, parent: "certificates", record: "certificate", element: <CertificateDetailPage /> },
  { id: "reports", path: "/app/reports", title: "API reports", description: "Each provider's promises, evidence and coverage.", icon: FileText, group: "Trust", element: <ReportsPage /> },
  { id: "report", path: "/app/reports/:tool", title: "API report", description: "One provider's certificate report.", icon: FileText, parent: "reports", record: "report", element: <ReportDetailPage /> },
  { id: "beliefs", path: "/app/beliefs", title: "Beliefs", description: "Trust earned through evidence.", icon: Scales, parent: "certificates", element: <BeliefsPage /> },
  { id: "belief", path: "/app/beliefs/:beliefId", title: "Belief", description: "One belief, its evidence and review.", icon: Scales, parent: "beliefs", record: "belief", element: <BeliefDetailPage /> },
  { id: "revocation-demo", path: "/app/revocation-demo", title: "Revocation", description: "A changed API loses its certificate (fixture).", icon: Prohibit, parent: "certificates", element: <RevocationDemoPage /> },
  // Act
  { id: "queue", path: "/app/queue", title: "Queue", description: "Every money action, accountable.", icon: QueueGlyph, group: "Act", badge: "held", element: <QueuePage /> },
  { id: "decision", path: "/app/queue/:decisionId", title: "Decision", description: "One decision, its guards, effects and evidence.", icon: QueueGlyph, parent: "queue", record: "decision", element: <DecisionDetailPage /> },
  { id: "approvals", path: "/app/approvals", title: "Approval desk", description: "Held money actions awaiting a human.", icon: Stamp, group: "Act", badge: "held", element: <ApprovalsPage /> },
  { id: "ask", path: "/app/ask", title: "Ask Notary", description: "Answers from records, with citations.", icon: ChatCircleText, group: "Act", element: <AskPage /> },
  // Business
  { id: "economics", path: "/app/economics", title: "Economics", description: "The cost of earning trust.", icon: CurrencyDollar, group: "Business", element: <EconomicsPage /> },
  { id: "evidence", path: "/app/evidence", title: "Evidence", description: "Receipts behind the demonstration.", icon: Receipt, group: "Business", element: <EvidencePage /> },
];

/** Old U5/U6 screen paths, kept working for shared links. Query strings are preserved. */
export const redirects: { from: string; to: string }[] = [
  { from: "/app/overview", to: "/app" },
  { from: "/app/comparison", to: "/app/runs" },
  { from: "/app/api-report", to: "/app/reports" },
  { from: "/app/revocation", to: "/app/revocation-demo" },
];

export const routeById = (id: string) => routes.find((r) => r.id === id);

/** The route (and its params) for a pathname. Most specific match wins. */
export function matchAppRoute(
  pathname: string,
): { route: AppRoute; params: Record<string, string | undefined> } | undefined {
  const normalized =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const route of [...routes].sort(
    (a, b) => b.path.split("/").length - a.path.split("/").length,
  )) {
    const m = matchPath({ path: route.path, end: true }, normalized);
    if (m) return { route, params: m.params };
  }
  return undefined;
}

/** Path relative to the /app/* splat, for <Route path>. */
export const relativePath = (path: string) =>
  path === "/app" ? "" : path.replace(/^\/app\//, "");
