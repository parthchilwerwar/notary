import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Toaster } from "sonner";
import { Button, EmptyState, FixtureNote, PageSkeleton, SkyBandContext, StatusPill } from "../../ui";
import { CommandPalette } from "./CommandPalette";
import { MobileBar, Sidebar } from "./Sidebar";
import { ShellStatusProvider } from "./status";
import { useTheme } from "../../useTheme";
import { useData } from "../../app/catalog";
import { LiveToasts } from "../../app/live-toasts";
import { withRun } from "../../app/links";
import { matchAppRoute, routeById, type AppRoute } from "../../routes";
import { dateTime as date } from "../../lib/time";
import "./shell.css";

/** Trail for the current route: list page › record id (or just the page title). */
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

/** Record pages: a link back to the list, above the title inside the sky band. */
function Breadcrumb() {
  const crumbs = useCrumbs();
  const { selectedRunId } = useData();
  if (crumbs.length < 2) return null;
  return (
    <nav className="band-crumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((c, i) => (
          <li key={i} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
            {c.path ? <Link to={withRun(c.path, selectedRunId)}>{c.label}</Link> : <span>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
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
  if (loading) return <PageSkeleton label="Verifying bundle integrity…" />;
  if (error)
    return (
      <EmptyState tone="error" title="Runs withheld" action={<Button onClick={reload}>Retry loading</Button>}>
        <p>A published run failed its integrity check in this browser, so nothing from it is shown. Re-export it with <code>pnpm notary export</code>.</p>
        <p className="gate-detail">{error}</p>
      </EmptyState>
    );
  if (!bundles.length)
    return (
      <EmptyState
        title="No runs published"
        action={
          <Button variant="secondary" asChild>
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
      <EmptyState
        tone="error"
        title={`Run ${missingRunId} is not published`}
        action={
          <Button asChild>
            <Link to="/app/run">Open the default run</Link>
          </Button>
        }
      >
        The link names a run that is not in the hash-verified catalog. Open the default run or pick one from the list.
      </EmptyState>
    );
  return <>{children}</>;
}

/**
 * The dashboard frame (K3): a white sidebar (phones: a top bar with a drawer), the canvas, the
 * fixture disclosure when the selected run is simulated, the command palette and toasts. The data
 * mode is not repeated as chrome: pages say what fails without a live server where it would fail.
 */
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
  const band = useMemo(() => ({ inShell: true, lead: <Breadcrumb /> }), []);
  const openPalette = () => setPaletteOpen(true);
  return (
    <ShellStatusProvider>
      <div className="app-shell">
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Sidebar dark={dark} setDark={setDark} onPalette={openPalette} />
        <div className="app-column">
          <MobileBar dark={dark} setDark={setDark} onPalette={openPalette} />
          <main id="main" className="app-main" tabIndex={-1}>
            {bundle?.sample && <FixtureNote className="fixture-banner" />}
            <SkyBandContext.Provider value={band}>
              <Gate ungated={!!match?.route.ungated}>{children}</Gate>
            </SkyBandContext.Provider>
          </main>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <Toaster theme={dark ? "dark" : "light"} position="bottom-right" />
        <LiveToasts />
      </div>
    </ShellStatusProvider>
  );
}
