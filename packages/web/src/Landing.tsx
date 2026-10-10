import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { MoonIcon as Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { SunIcon as Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import type { CertificateReport, RunBundle, TimelineFile } from "../../core/src/schema";
import { Button } from "./components/ui/button";
import { Hero } from "./components/landing/Hero";
import { DoubleRefund } from "./components/landing/DoubleRefund";
import { ProcessSteps } from "./components/landing/ProcessSteps";
import { MissionReplay } from "./components/landing/MissionReplay";
import { RequiredTools } from "./components/landing/RequiredTools";
import { Results } from "./components/landing/Results";
import { FinalCTA } from "./components/landing/FinalCTA";
import { LandingFooter } from "./components/landing/LandingFooter";
import { useTheme } from "./useTheme";
import {
  byNewest,
  entryOfBundle,
  finishedEntries,
  loadEvidence,
  toCertificateView,
  useDataSource,
  type EvidenceEntry,
} from "./data";
import {
  fixturePair,
  landingResults,
  loadReplay,
  realRuns,
  replayRunIds,
} from "./landing-data";
import { unsafeDecisionIds } from "./pages/mission-control/model";
import "./landing.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Landing() {
  const [dark, setDark] = useTheme();
  const { source, ready } = useDataSource();
  const [all, setAll] = useState<RunBundle[]>([]);
  const [bundleError, setBundleError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<EvidenceEntry[]>([]);
  const [toolError, setToolError] = useState("");
  const [toolsLoading, setToolsLoading] = useState(true);
  const [timelines, setTimelines] = useState<TimelineFile[]>([]);
  const [replayError, setReplayError] = useState("");
  const [replayLoading, setReplayLoading] = useState(true);
  const [fixtureReport, setFixtureReport] = useState<{ scenario?: string; report: CertificateReport }>();
  const [realReport, setRealReport] = useState<CertificateReport>();
  const [certError, setCertError] = useState("");

  useEffect(() => {
    document.title = "Notary — certificates for API behavior";
  }, []);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const { signal } = controller;
    const live = () => !signal.aborted;
    (async () => {
      const entries = finishedEntries(await source.listRuns(signal));
      // Hash-verified by the data layer.
      return (await Promise.all(entries.map((e) => source.getRun(e.runId, signal)))).sort(byNewest);
    })()
      .then(async (bundles) => {
        if (!live()) return;
        setAll(bundles);
        setLoading(false);
        await Promise.all([
          loadReplay(bundles, (id, s) => source.getTimeline(id, s), signal)
            .then((files) => live() && setTimelines(files))
            .catch((e) => live() && setReplayError(message(e)))
            .finally(() => live() && setReplayLoading(false)),
          // The fixture certificate scenario whose sources include this world's notarize runs.
          (async () => {
            const first = bundles.find((b) => b.runId === replayRunIds(bundles)[0]);
            if (!first) return;
            const w = toCertificateView(await source.certificates(entryOfBundle(first), signal));
            if (live() && w) setFixtureReport({ scenario: w.scenario, report: w.report });
          })().catch((e) => live() && setCertError(message(e))),
          source
            .certificates(undefined, signal)
            .then((w) => live() && w.report && setRealReport(w.report))
            .catch((e) => live() && setCertError(message(e))),
        ]);
      })
      .catch((e) => {
        if (!live()) return;
        setBundleError(message(e));
        setLoading(false);
        setReplayLoading(false);
      });
    loadEvidence(signal)
      .then((entries) => live() && setTools(entries))
      .catch((e) => live() && setToolError(message(e)))
      .finally(() => live() && setToolsLoading(false));
    return () => controller.abort();
  }, [source, ready]);

  const fixture = fixturePair(all);
  const real = landingResults(all.filter((b) => !b.sample));
  const realCounts = realRuns(all);
  const unsafe = useMemo(() => {
    const ids = new Set<string>();
    for (const f of timelines) {
      const b = all.find((x) => x.runId === f.runId);
      if (b) for (const id of unsafeDecisionIds(b)) ids.add(id);
    }
    return ids;
  }, [timelines, all]);

  return (
    <div className="landing">
      <a className="skip" href="#landing-main">
        Skip to content
      </a>
      <header className="landing-header">
        <Link className="brand" to="/" aria-label="Notary home">
          <ShieldCheck size={23} aria-hidden="true" />
          Notary<span className="brand-period">.</span>
        </Link>
        <nav aria-label="Landing sections">
          <a href="#problem">The problem</a>
          <a href="#how-it-works">How it works</a>
          <a href="#replay">Replay</a>
          <a href="#required-tools">Tools</a>
          <a href="#results">Results</a>
        </nav>
        <div className="landing-header-actions">
          <Button
            variant="outline"
            size="icon"
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
          <Button asChild>
            <Link to="/app">Dashboard</Link>
          </Button>
        </div>
      </header>
      <main id="landing-main">
        <Hero />
        <DoubleRefund
          naive={fixture.naive}
          guarded={fixture.guarded}
          loading={loading}
          error={bundleError}
        />
        <ProcessSteps />
        <MissionReplay
          files={timelines}
          unsafe={unsafe}
          loading={loading || replayLoading}
          error={bundleError || replayError}
        />
        <RequiredTools tools={tools} error={toolError} loading={toolsLoading} />
        <Results
          loading={loading}
          error={bundleError}
          fixture={fixture}
          real={{ ...realCounts, naive: real.naive, guarded: real.guarded }}
          fixtureReport={fixtureReport}
          realReport={realReport}
          certError={certError}
        />
        <FinalCTA />
        <LandingFooter />
      </main>
    </div>
  );
}
