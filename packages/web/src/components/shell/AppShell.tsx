import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Toaster } from "sonner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../ui/sidebar";
import { Button } from "../ui/button";
import { FixtureBanner } from "../ui/fixture-banner";
import { StatusPill } from "../ui/status-pill";
import { EmptyState, ErrorState, LoadingState } from "../ui/states";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";
import { RunPicker } from "./RunPicker";
import { ShellStatusProvider } from "./status";
import { ASK_KEYSHORTCUTS, ASK_SHORTCUT_LABEL, AskProvider, AskSheet, MOD_KEY_LABEL, useAsk } from "../ask";
import { useTheme } from "../../useTheme";
import { useData } from "../../app/catalog";
import { LiveToasts } from "../../app/live-toasts";
import { withRun } from "../../app/links";
import { matchAppRoute, routeById, type AppRoute } from "../../routes";
import { dateTime as date } from "../../lib/time";
import "./shell.css";

/** Top-bar trail for the current route: list page › record id (or just the page title). */
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
  return chain.map((c, i) => ({
    label: i === chain.length - 1 && record ? decodeURIComponent(record) : c.title,
    path: i === chain.length - 1 ? undefined : c.path,
  }));
}

function TopBar({ onPalette }: { onPalette: () => void }) {
  const crumbs = useCrumbs();
  const { pathname } = useLocation();
  // The Run page has its own run selector (?run=); a second picker here would duplicate it.
  const ownPicker = matchAppRoute(pathname)?.route.id === "run";
  const { selectedRunId } = useData();
  const ask = useAsk();
  return (
    <header className="app-topbar">
      <SidebarTrigger />
      <nav className="topbar-trail" aria-label="Breadcrumb">
        <ol>
          {crumbs.map((c, i) => (
            <li key={i} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
              {c.path ? <Link to={withRun(c.path, selectedRunId)}>{c.label}</Link> : <span>{c.label}</span>}
            </li>
          ))}
        </ol>
      </nav>
      <div className="app-topbar-actions">
        {!ownPicker && <RunPicker />}
        <button
          type="button"
          className="topbar-button"
          onClick={onPalette}
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K"
        >
          Search
          <kbd aria-hidden="true">{MOD_KEY_LABEL} K</kbd>
        </button>
        <button
          type="button"
          className="topbar-button"
          onClick={() => ask.setOpen(true)}
          aria-haspopup="dialog"
          aria-keyshortcuts={ASK_KEYSHORTCUTS}
        >
          Ask
          <kbd aria-hidden="true">{ASK_SHORTCUT_LABEL}</kbd>
        </button>
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
      <span>
        Hash verified in this browser{" "}
        <code title={bundle.contentHash}>{bundle.contentHash.slice(0, 12)}…</code>
      </span>
      <span>
        {bundle.runId} · {bundle.kind} / {bundle.variant}
      </span>
      <StatusPill value={bundle.status} />
      <span>{date(bundle.startedAt)}</span>
    </div>
  );
}

function Gate({ children, ungated }: { children: ReactNode; ungated: boolean }) {
  const { loading, error, bundles, missingRunId, reload, running } = useData();
  if (ungated) return <>{children}</>;
  if (loading) return <LoadingState />;
  if (error)
    return (
      <ErrorState title="Runs withheld" actions={<Button onClick={reload}>Retry loading</Button>}>
        {error}
      </ErrorState>
    );
  if (!bundles.length)
    return (
      <EmptyState
        title="No runs published"
        actions={
          <Button variant="outline" asChild>
            <Link to="/app/report">Check connections</Link>
          </Button>
        }
      >
        Publish verified exports with <code>pnpm notary export</code>, or start <code>pnpm notary serve</code> for
        live runs.
      </EmptyState>
    );
  // A live run that is still running has no bundle yet; it is not "unpublished".
  if (missingRunId && !running.some((r) => r.runId === missingRunId))
    return (
      <ErrorState
        title={`Run ${missingRunId} is not published`}
        actions={
          <Button asChild>
            <Link to="/app/run">Open the default run</Link>
          </Button>
        }
      >
        The link names a run that is not in the hash-verified catalog.
      </ErrorState>
    );
  return <>{children}</>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dark, setDark] = useTheme();
  const { bundle } = useData();
  const { pathname } = useLocation();
  const match = matchAppRoute(pathname);
  useEffect(() => {
    document.title = `${match?.route.title ?? "Not found"} · Notary`;
  }, [match?.route.title]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <ShellStatusProvider>
      <AskProvider>
        <SidebarProvider>
          <a className="skip" href="#main">
            Skip to content
          </a>
          <AppSidebar dark={dark} setDark={setDark} />
          <SidebarInset>
            {bundle?.sample && <FixtureBanner />}
            <TopBar onPalette={() => setPaletteOpen(true)} />
            <main id="main" className="app-main" tabIndex={-1}>
              <Gate ungated={!!match?.route.ungated}>{children}</Gate>
            </main>
          </SidebarInset>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
          <AskSheet />
          <Toaster theme={dark ? "dark" : "light"} position="bottom-right" />
          <LiveToasts />
        </SidebarProvider>
      </AskProvider>
    </ShellStatusProvider>
  );
}
