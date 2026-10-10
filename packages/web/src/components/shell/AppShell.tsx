import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Toaster } from "sonner";
import { MoonIcon as Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { SunIcon as Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { GithubLogoIcon as GithubLogo } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ArrowsClockwiseIcon as Reload } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "../ui/sidebar";
import { Button } from "../ui/button";
import { FixtureBanner } from "../ui/fixture-banner";
import { StatusPill } from "../ui/status-pill";
import { EmptyState, ErrorState, LoadingState } from "../ui/states";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";
import { RunPicker } from "./RunPicker";
import { useTheme } from "../../useTheme";
import { useData } from "../../state/DataProvider";
import { LiveToasts } from "../../state/live";
import { MODE_LABEL, withRun } from "../../state/data-mode";
import { matchAppRoute, routeById, type AppRoute } from "../../routes";
import { date } from "../../data";
import "./shell.css";

/** Breadcrumb trail for the current route: group › list page › record id. */
export function useCrumbs(): { label: string; path?: string }[] {
  const { pathname } = useLocation();
  const match = matchAppRoute(pathname);
  if (!match) return [{ label: "Not found" }];
  const chain: AppRoute[] = [];
  let r: AppRoute | undefined = match.route;
  while (r) {
    chain.unshift(r);
    r = r.parent ? routeById(r.parent) : undefined;
  }
  const record = Object.values(match.params)[0];
  return [
    ...(chain[0]?.group ? [{ label: chain[0].group }] : []),
    ...chain.map((c, i) => ({
      label: i === chain.length - 1 && record ? decodeURIComponent(record) : c.title,
      path: i === chain.length - 1 ? undefined : c.path,
    })),
  ];
}

function TopBar({
  onPalette,
  dark,
  setDark,
}: {
  onPalette: () => void;
  dark: boolean;
  setDark: (dark: boolean) => void;
}) {
  const crumbs = useCrumbs();
  const { selectedRunId } = useData();
  return (
    <header className="app-topbar">
      <SidebarTrigger />
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <ol>
          {crumbs.map((c, i) => (
            <li key={i} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
              {i > 0 && <CaretRight size={12} aria-hidden="true" />}
              {c.path ? (
                <Link to={withRun(c.path, selectedRunId)}>{c.label}</Link>
              ) : (
                <span>{c.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="app-topbar-actions">
        <RunPicker />
        <button
          type="button"
          className="palette-trigger"
          onClick={onPalette}
          aria-label="Open command palette (Ctrl+K)"
        >
          <MagnifyingGlass size={16} aria-hidden="true" />
          <span className="palette-trigger-text">Search</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => setDark(!dark)}
        >
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <a
          className="icon-button hide-mobile"
          href="https://github.com/parthchilwerwar/notary"
          target="_blank"
          rel="noreferrer"
          aria-label="Notary on GitHub"
        >
          <GithubLogo size={18} />
        </a>
      </div>
    </header>
  );
}

/** Integrity receipt of the selected run: verified hash, kind, status and provenance. */
export function RunReceipt() {
  const { bundle } = useData();
  if (!bundle) return null;
  return (
    <div className="run-receipt">
      <span className="verified">
        <ShieldCheck size={16} aria-hidden="true" />
        Hash verified{" "}
        <code title={bundle.contentHash}>{bundle.contentHash.slice(0, 12)}…</code>
      </span>
      <span>
        {bundle.runId} · {bundle.kind} / {bundle.variant}
      </span>
      <StatusPill value={bundle.status} />
      <span>{date(bundle.startedAt)} IST</span>
      <details className="disclosures">
        <summary>Run provenance</summary>
        <div>
          {bundle.disclosure.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
          <p>
            Run: {bundle.runId} · Seed: {bundle.seed} · Mode: {bundle.mode}
          </p>
          <p>
            Content hash: <code>{bundle.contentHash}</code>
          </p>
          {bundle.stopReason && <p>Stopped: {bundle.stopReason}</p>}
          <p>
            Finished: {bundle.finishedAt ? date(bundle.finishedAt) : "Not recorded"}
          </p>
        </div>
      </details>
    </div>
  );
}

/** Routes about the whole data world rather than the selected run: no run receipt. */
const NO_RECEIPT = new Set(["run", "evidence", "revocation-demo"]);

function Gate({ children }: { children: ReactNode }) {
  const { loading, error, bundles, missingRunId, reload, runs } = useData();
  if (loading) return <LoadingState />;
  if (error)
    return (
      <ErrorState
        title="Bundle unavailable"
        actions={<Button onClick={reload}><Reload /> Retry loading</Button>}
      >
        {error}
      </ErrorState>
    );
  if (!bundles.length)
    return (
      <EmptyState title="No bundles published">
        Publish verified exports (<code>pnpm notary export</code>) to inspect
        recorded outcomes.
      </EmptyState>
    );
  if (missingRunId)
    return (
      <ErrorState
        title={`Run ${missingRunId} is not published`}
        actions={
          <Button asChild>
            <Link to={withRun("/app", undefined)}>Open the default run</Link>
          </Button>
        }
      >
        The link names a run that is not in the {runs.length ? "" : "empty "}
        hash-verified catalog.
      </ErrorState>
    );
  return <>{children}</>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dark, setDark] = useTheme();
  const { bundle, mode } = useData();
  const { pathname } = useLocation();
  const match = matchAppRoute(pathname);
  useEffect(() => {
    const title = match?.route.title ?? "Not found";
    document.title = `${title} · Notary`;
  }, [match?.route.title]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <SidebarProvider>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <AppSidebar />
      <SidebarInset>
        {bundle?.sample && <FixtureBanner />}
        <TopBar
          onPalette={() => setPaletteOpen(true)}
          dark={dark}
          setDark={setDark}
        />
        <main id="main" className="app-main">
          <Gate>
            {match && !NO_RECEIPT.has(match.route.id) && <RunReceipt />}
            {children}
          </Gate>
          <footer className="page-footer">
            <span>Notary · Evidence before action.</span>
            <span>
              {MODE_LABEL[mode]} data · Browser-verified integrity
            </span>
          </footer>
        </main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Toaster theme={dark ? "dark" : "light"} position="bottom-right" />
      <LiveToasts />
    </SidebarProvider>
  );
}
