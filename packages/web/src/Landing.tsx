import { useEffect, useState } from "react";
import { Link } from "react-router";
import { MoonIcon as Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { SunIcon as Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import type { RunBundle } from "../../core/src/schema";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Hero } from "./components/landing/Hero";
import { ProblemBento } from "./components/landing/ProblemBento";
import { ProcessSteps } from "./components/landing/ProcessSteps";
import { ResultsStrip } from "./components/landing/ResultsStrip";
import { FinalCTA } from "./components/landing/FinalCTA";
import { LandingFooter } from "./components/landing/LandingFooter";
import { useTheme } from "./useTheme";
import { loadCatalog, safeLink } from "./data";
import { loadEvidence, landingResults } from "./landing-data";
import "./landing.css";
export default function Landing() {
  const [dark, setDark] = useTheme();
  const [all, setAll] = useState<RunBundle[]>([]);
  const [tools, setTools] = useState<Awaited<ReturnType<typeof loadEvidence>>>(
    [],
  );
  const [bundleError, setBundleError] = useState("");
  const [toolError, setToolError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    loadCatalog(controller.signal)
      .then((b) => {
        if (!controller.signal.aborted) {
          setAll(b);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setBundleError(e.message);
          setLoading(false);
        }
      });
    loadEvidence(controller.signal)
      .then((entries) => {
        if (!controller.signal.aborted) setTools(entries);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setToolError(e.message);
      });
    return () => controller.abort();
  }, []);
  const results = landingResults(all);
  const hasResults = !!(results.naive || results.guarded);
  const fixture = results.sample && hasResults;
  return (
    <div className="landing">
      <a className="skip" href="#landing-main">
        Skip to content
      </a>
      {fixture && (
        <div className="fixture-banner" role="note">
          <ShieldCheck size={18} aria-hidden="true" />
          <span>Fixture data — simulated APIs, not a live run</span>
        </div>
      )}
      <header className="landing-header">
        <Link className="brand" to="/">
          <ShieldCheck size={23} aria-hidden="true" />
          Notary<span className="brand-period">.</span>
        </Link>
        <nav aria-label="Landing navigation">
          <a href="#problem">The problem</a>
          <a href="#how-it-works">How it works</a>
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
        <ProblemBento />
        <ProcessSteps />
        <section id="required-tools" className="landing-section">
          <div className="chapter-heading">
            <span className="eyebrow">Required tools</span>
            <h2>Evidence needs a paper trail.</h2>
            <p>
              Tool roles and integration status come from the published evidence
              file.
            </p>
          </div>
          {toolError && (
            <p role="alert" className="landing-data-error">
              {toolError} Tool status remains Pending.
            </p>
          )}
          <div className="landing-tools">
            {["neatlogs", "Entire", "cfo.ai"].map((name) => {
              const tool = tools.find(
                (t) => t.name.toLowerCase() === name.toLowerCase(),
              );
              return (
                <Card className="landing-tool" key={name}>
                  <div className="tool-title">
                    <h3>{name}</h3>
                    <span
                      className={`tool-status ${tool?.status === "live" ? "recorded" : ""}`}
                    >
                      {tool?.status ?? "Pending"}
                    </span>
                  </div>
                  <p>{tool?.purpose ?? "Pending"}</p>
                  {tool?.notes && (
                    <details className="record-details">
                      <summary>Evidence and limitations</summary>
                      <p>{tool.notes}</p>
                    </details>
                  )}
                  <div className="tool-links">
                    {tool?.links.map(
                      (link) =>
                        safeLink(link.url) && (
                          <a
                            key={link.url}
                            href={safeLink(link.url)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {link.label} ↗
                          </a>
                        ),
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
        <section id="results" className="landing-section">
          <div className="chapter-heading">
            <span className="eyebrow">Results</span>
            <h2>Naive vs guarded. Read the receipts.</h2>
            <p>
              Naive and guarded outcomes, directly from browser-verified
              bundles.
            </p>
          </div>
          {fixture && (
            <p className="landing-fixture-label">
              Fixture data — simulated APIs with planted quirks
            </p>
          )}
          {loading ? (
            <div className="result-state" role="status">
              Verifying result bundles…
            </div>
          ) : bundleError ? (
            <div className="result-state" role="alert">
              <h3>Results unavailable</h3>
              <p>{bundleError}</p>
            </div>
          ) : !hasResults ? (
            <div className="result-state">
              <h3>
                {results.sample
                  ? "Results pending"
                  : "Live queue results pending"}
              </h3>
              <p>
                Publish naive and guarded queue bundles to compare their
                outcomes.
              </p>
            </div>
          ) : (
            <>
              <p className="cohort-label">
                {results.sample ? "Fixture comparison" : "Recorded live runs"}
                {(!results.naive || !results.guarded) &&
                  " · counterpart pending"}
              </p>
              <ResultsStrip naive={results.naive} guarded={results.guarded} />
              <Button variant="outline" asChild>
                <Link
                  to={`/app/runs?run=${encodeURIComponent((results.guarded ?? results.naive)!.runId)}${results.naive && results.guarded ? `&baseline=${encodeURIComponent(results.naive.runId)}` : ""}`}
                >
                  Inspect the run comparison
                </Link>
              </Button>
            </>
          )}
        </section>
        <FinalCTA />
        <LandingFooter />
      </main>
    </div>
  );
}
