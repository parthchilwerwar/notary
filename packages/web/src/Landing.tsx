// The landing page (`/`). Hero, Proof (numbers from the latest exported naive/guarded pair),
// How it works, Watch it work (a recorded excerpt), Built with, footer. Every number comes from
// hash-verified bundles through the data layer (useDataSource); see landing-data.ts.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { BundleIndexEntry, RunBundle } from "../../core/src/schema";
import { finishedEntries, useDataSource } from "./data";
import { BUILT_WITH, GITHUB_URL, proofNumbers, proofPair } from "./landing-data";
import { Hero } from "./components/landing/Hero";
import { Proof, type ProofState } from "./components/landing/Proof";
import { HowItWorks } from "./components/landing/HowItWorks";
import { ScrollTrigger, useGSAP } from "./components/landing/gsap";
import { useTheme } from "./useTheme";
import "./design/tokens.css";
import "./landing.css";

const Excerpt = lazy(() => import("./components/landing/Excerpt"));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Landing() {
  const [dark, setDark] = useTheme();
  const { source, ready } = useDataSource();
  const [entries, setEntries] = useState<BundleIndexEntry[]>([]);
  const [proof, setProof] = useState<ProofState>({ status: "loading" });
  const [guarded, setGuarded] = useState<RunBundle>();

  useEffect(() => {
    document.title = "Notary: no certificate, no money moves";
  }, []);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      const all = finishedEntries(await source.listRuns(signal));
      const pair = proofPair(all);
      if (!pair.naive || !pair.guarded) {
        if (!signal.aborted) {
          setEntries(all);
          setProof({
            status: "empty",
            message:
              "No naive and guarded run pair from one scenario has been exported yet; pnpm notary demo --fixture --publish publishes a fixture pair.",
          });
        }
        return;
      }
      // Hash-verified by the data layer; a mismatch throws and the error is shown instead.
      // One after the other so each bundle's hash check is its own main-thread task.
      const naive = await source.getRun(pair.naive.runId, signal);
      const guardedRun = await source.getRun(pair.guarded.runId, signal);
      if (signal.aborted) return;
      setEntries(all);
      setGuarded(guardedRun);
      setProof({ status: "ready", naive, guarded: guardedRun, numbers: proofNumbers(naive, guardedRun), note: pair.note });
    })().catch((e) => {
      if (!signal.aborted) setProof({ status: "error", message: message(e) });
    });
    return () => controller.abort();
  }, [source, ready]);

  return (
    <div className="landing">
      <a className="l-skip" href="#landing-main">
        Skip to content
      </a>
      <header className="l-header">
        <Link className="l-wordmark" to="/" aria-label="Notary home">
          Notary
        </Link>
        <button
          type="button"
          className="l-theme"
          aria-pressed={dark}
          onClick={() => setDark(!dark)}
        >
          Dark theme
        </button>
      </header>
      <main id="landing-main" className="l-main">
        <Hero />
        <Proof state={proof} />
        <HowItWorks />
        <WatchItWork guarded={guarded} entries={entries} proofStatus={proof.status} />
        <section className="l-section" aria-labelledby="built-title">
          <h2 id="built-title" className="l-h2">
            Built with
          </h2>
          <ul className="l-built">
            {BUILT_WITH.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>
      </main>
      <footer className="l-footer">
        <div className="l-footer-inner">
          <span>Built for neatHack</span>
          <a href={GITHUB_URL} rel="noreferrer">
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

/** Mounts the lazy excerpt (and fetches its timelines) only when the section nears the viewport. */
function WatchItWork({
  guarded,
  entries,
  proofStatus,
}: {
  guarded?: RunBundle;
  entries: BundleIndexEntry[];
  proofStatus: ProofState["status"];
}) {
  const root = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const { source } = useDataSource();

  useGSAP(
    () => {
      // Not an animation: a one-shot visibility trigger, so it also runs under reduced motion.
      ScrollTrigger.create({
        trigger: root.current,
        start: "top bottom+=400",
        once: true,
        onEnter: () => setNear(true),
      });
    },
    { scope: root },
  );

  return (
    <section className="l-section l-watch" ref={root} aria-labelledby="watch-title">
      <h2 id="watch-title" className="l-h2">
        Watch it work
      </h2>
      <p className="l-lede">
        Recorded events from the guarded run’s world, in order: how one claim was tested and why a
        refund that depended on it was held.
      </p>
      <div className="l-watch-body">
        {guarded && near ? (
          <Suspense fallback={<p className="l-lede">Loading the recorded run…</p>}>
            <Excerpt source={source} entries={entries} guarded={guarded} />
          </Suspense>
        ) : proofStatus === "error" || proofStatus === "empty" ? (
          <p className="l-lede">No recorded run to show.</p>
        ) : (
          <p className="l-lede">Loading the recorded run…</p>
        )}
      </div>
    </section>
  );
}
