import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Toaster } from "sonner";
import { Button, EmptyState, FixtureNote, NoRunsYet, Page, PageBody, PageHeader, PageHeaderContext, PageSkeleton, ReplayBadge, StatusPill } from "../../ui";
import { CommandPalette } from "./CommandPalette";
import { MobileBar, Sidebar } from "./Sidebar";
import { ShellStatusProvider } from "./status";
import { useData } from "../../app/catalog";
import { LiveToasts } from "../../app/live-toasts";
import { keepView, NO_RUNS_COMMANDS, replayBadge, withRun } from "../../app/links";
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

/** Record pages: a link back to the list, above the page title. */
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
      {replayBadge(bundle) && <ReplayBadge>{replayBadge(bundle)}</ReplayBadge>}
      <StatusPill value={bundle.status} />
      <span>{date(bundle.startedAt)}</span>
    </div>
  );
}

/**
 * Nothing to show: no real run is published (or, under ?fixtures=1, no fixture run). Never a
 * fallback to fixture data. The page keeps its title so the shell still reads as that page.
 */
export function NoRunsPage({ title, fixtures }: { title: string; fixtures: boolean }) {
  return (
    <Page>
      <PageHeader title={title} summary={fixtures ? "No fixture runs are published" : "No runs recorded yet"} />
      <PageBody>
        {fixtures ? (
          <EmptyState
            title="No fixture runs published"
            action={
              <Button variant="secondary" asChild>
                <Link to="/app/run">Show recorded runs</Link>
              </Button>
            }
          >
            The fixture view lists <code>sample: true</code> bundles only, and none are published. Remove{" "}
            <code>?fixtures=1</code> to see recorded runs.
          </EmptyState>
        ) : (
          <NoRunsYet
            commands={NO_RUNS_COMMANDS}
            action={
              <Button variant="secondary" asChild>
                <Link to="/app/report">Check connections</Link>
              </Button>
            }
          />
        )}
      </PageBody>
    </Page>
  );
}

/** Routes that stay useful with no run: Report (connections) and, against a live server, Run (it starts runs). */
function worksWithoutRuns(routeId: string | undefined, source: "api" | "static"): boolean {
  return routeId === "report" || (routeId === "run" && source === "api");
}

function Gate({ children, ungated, routeId, title }: { children: ReactNode; ungated: boolean; routeId?: string; title: string }) {
  const { loading, error, bundles, missingRunId, reload, running, fixtures, source } = useData();
  const empty = !loading && !error && !bundles.length && !running.length;
  if (empty && !worksWithoutRuns(routeId, source)) return <NoRunsPage title={title} fixtures={fixtures} />;
  if (ungated) return <>{children}</>;
  if (loading) return <PageSkeleton label="Verifying bundle integrity…" />;
  if (error)
    return (
      <EmptyState tone="error" title="Runs withheld" action={<Button onClick={reload}>Retry loading</Button>}>
        <p>A published run failed its integrity check in this browser, so nothing from it is shown. Re-export it with <code>pnpm notary export</code>.</p>
        <p className="gate-detail">{error}</p>
      </EmptyState>
    );
  if (!bundles.length) return <NoRunsPage title={title} fixtures={fixtures} />;
  // A live run that is still running has no bundle yet; it is not "unpublished".
  if (missingRunId && !running.some((r) => r.runId === missingRunId))
    return (
      <EmptyState
        tone="error"
        title={`Run ${missingRunId} is not published`}
        action={
          <Button asChild>
            <Link to={keepView("/app/run")}>Open the default run</Link>
          </Button>
        }
      >
        The link names a run that is not in the hash-verified catalog. Open the default run or pick one from the list.
      </EmptyState>
    );
  return <>{children}</>;
}

/**
 * The dashboard frame: a quiet sidebar (phones: a top bar with a drawer), the white page, the
 * command palette and toasts. Light only. Only real runs are shown; fixture runs appear only in the
 * development-only `?fixtures=1` view, and there every page header carries the fixture disclosure
 * (one small pill on the summary line, present only when the selected run is fixture data). The
 * data mode is not repeated as chrome: pages say what fails without a live server where it would.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { bundle } = useData();
  const { pathname } = useLocation();
  const match = matchAppRoute(pathname);
  useEffect(() => {
    document.title = `${match?.route.title ?? "Not found"} · Notary`;
  }, [match?.route.title]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  const sample = !!bundle?.sample;
  const header = useMemo(
    () => ({ inShell: true, lead: <Breadcrumb />, note: sample ? <FixtureNote className="fixture-banner" /> : undefined }),
    [sample],
  );
  const openPalette = () => setPaletteOpen(true);
  return (
    <ShellStatusProvider>
      <div className="app-shell">
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Sidebar onPalette={openPalette} />
        <div className="app-column">
          <MobileBar onPalette={openPalette} />
          <main id="main" className="app-main" tabIndex={-1}>
            <PageHeaderContext.Provider value={header}>
              <Gate ungated={!!match?.route.ungated} routeId={match?.route.id} title={match?.route.title ?? "Notary"}>
                {children}
              </Gate>
            </PageHeaderContext.Provider>
          </main>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <Toaster theme="light" position="bottom-right" />
        <LiveToasts />
      </div>
    </ShellStatusProvider>
  );
}
