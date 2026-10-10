import { useEffect, useState } from "react";
import { MoonIcon as Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { SunIcon as Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { GithubLogoIcon as GithubLogo } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ArrowsClockwiseIcon as Reload } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import type { RunBundle } from "../../core/src/schema";
import { Button } from "./components/ui/button";
import { Beliefs } from "./Beliefs";
import { Queue } from "./Queue";
import { Overview } from "./Overview";
import { ProbeLog } from "./ProbeLog";
import { Comparison } from "./Comparison";
import { Economics } from "./Economics";
import { Evidence } from "./Evidence";
import { Empty, Status } from "./components";
import { comparable } from "./analytics";
import { date, label, loadCatalog } from "./data";

const screens = [
  {
    id: "overview",
    name: "Overview",
    description: "A clearer view of money, decisions and trust.",
  },
  {
    id: "queue",
    name: "Queue",
    description: "Every money action, accountable.",
  },
  {
    id: "beliefs",
    name: "Beliefs",
    description: "Trust earned through evidence.",
  },
  {
    id: "probes",
    name: "Probe log",
    description: "Predictions first. Observations second.",
  },
  {
    id: "comparison",
    name: "Runs comparison",
    description: "See what changed between recorded runs.",
  },
  {
    id: "economics",
    name: "Economics",
    description: "The cost of earning trust.",
  },
  {
    id: "evidence",
    name: "Evidence",
    description: "Receipts behind the demonstration.",
  },
] as const;
type Screen = (typeof screens)[number]["id"];

export default function App() {
  const [screen, setScreen] = useState<Screen>(
    () => screens.find((s) => `#${s.id}` === location.hash)?.id ?? "overview",
  );
  const [all, setAll] = useState<RunBundle[]>([]);
  const [selected, setSelected] = useState("");
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setAll([]);
    loadCatalog(controller.signal)
      .then((bundles) => {
        if (controller.signal.aborted) return;
        setAll(bundles);
        setSelected((current) =>
          bundles.some((b) => b.runId === current)
            ? current
            : ((
                bundles.find(
                  (b) => b.variant === "guarded" && b.kind === "run",
                ) ?? bundles[0]
              )?.runId ?? ""),
        );
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [reload]);
  const bundle = all.find((b) => b.runId === selected);
  const candidates = bundle
    ? all.filter((b) => b.runId !== selected && comparable(bundle, b))
    : [];
  const comparison =
    candidates.find((b) => b.runId === baseline) ??
    candidates.find(
      (b) =>
        b.variant === (bundle?.variant === "naive" ? "guarded" : "naive") &&
        b.kind === "run",
    ) ??
    candidates.find((b) => b.kind === bundle?.kind) ??
    candidates[0];
  function navigate(id: Screen) {
    setScreen(id);
    location.hash = id;
    if (id === "probes" && bundle && !bundle.probes.length) {
      const source = all.find((b) => comparable(bundle, b) && b.probes.length);
      if (source) {
        setSelected(source.runId);
        setBaseline("");
      }
    } else if (
      (id === "queue" || id === "comparison" || id === "overview") &&
      bundle?.kind !== "run"
    ) {
      const source = all.find(
        (b) =>
          bundle &&
          comparable(bundle, b) &&
          b.kind === "run" &&
          b.variant === "guarded",
      );
      if (source) {
        setSelected(source.runId);
        setBaseline("");
      }
    }
  }
  const current = screens.find((s) => s.id === screen)!;
  const fixture =
    bundle?.sample || (screen === "evidence" && all.some((b) => b.sample));
  return (
    <div className="app-shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      {fixture && (
        <div className="fixture-banner" role="note">
          <ShieldCheck size={18} aria-hidden="true" />
          <span>Fixture data — simulated APIs, not a live run</span>
        </div>
      )}
      <header className="topbar">
        <a
          className="brand"
          href="#overview"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <span className="brand-mark">
            <ShieldCheck size={23} aria-hidden="true" />
          </span>
          Notary<span className="brand-period">.</span>
        </a>
        <nav aria-label="Dashboard screens">
          {screens.map((s) => (
            <Button
              variant="ghost"
              key={s.id}
              aria-current={s.id === screen ? "page" : undefined}
              className={s.id === screen ? "nav-pill active" : "nav-pill"}
              onClick={() => navigate(s.id)}
            >
              {s.name}
            </Button>
          ))}
        </nav>
        <div className="topbar-actions">
          <Button
            variant="outline"
            size="icon"
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
          <Button variant="outline" size="icon" asChild>
            <a
              href="https://github.com/parthchilwerwar/notary"
              target="_blank"
              rel="noreferrer"
              aria-label="Notary on GitHub"
            >
              <GithubLogo />
            </a>
          </Button>
        </div>
      </header>
      <main id="main">
        <div className="page-heading">
          <div>
            <span className="eyebrow">Evidence before action</span>
            <h1>{current.name}</h1>
            <p>{current.description}</p>
          </div>
          <div className="run-controls">
            <label>
              Selected run
              <select
                aria-label="Selected run"
                value={selected}
                disabled={!all.length}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setBaseline("");
                }}
              >
                {!all.length && <option value="">No bundles available</option>}
                {all.map((b) => (
                  <option key={b.runId} value={b.runId}>
                    {b.runId} · {b.sample ? "Fixture" : "Live"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Compare with
              <select
                aria-label="Compare with"
                value={comparison?.runId ?? ""}
                disabled={!candidates.length}
                onChange={(e) => setBaseline(e.target.value)}
              >
                {!candidates.length && (
                  <option value="">No same-kind baseline</option>
                )}
                {candidates.map((b) => (
                  <option key={b.runId} value={b.runId}>
                    {label(b.variant)} · {b.runId}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              size="icon"
              aria-label="Reload bundles"
              onClick={() => setReload((v) => v + 1)}
            >
              <Reload />
            </Button>
          </div>
        </div>
        {error ? (
          <div className="error" role="alert">
            <h2>Bundle unavailable</h2>
            <p>{error}</p>
            <Button onClick={() => setReload((v) => v + 1)}>
              Retry loading
            </Button>
          </div>
        ) : loading ? (
          <div className="loading" role="status">
            <h2>Verifying bundle integrity…</h2>
            <p>
              Checking the shared schema and recomputing every content hash.
            </p>
          </div>
        ) : !bundle ? (
          <Empty title="No bundles published">
            Publish verified exports to inspect recorded outcomes.
          </Empty>
        ) : (
          <>
            <div className="run-receipt">
              <span className="verified">
                <ShieldCheck size={16} aria-hidden="true" />
                Hash verified{" "}
                <code title={bundle.contentHash}>
                  {bundle.contentHash.slice(0, 12)}…
                </code>
              </span>
              <span>
                {bundle.kind} / {bundle.variant}
              </span>
              <Status value={bundle.status} />
              <span>{date(bundle.startedAt)} IST</span>
              <details className="disclosures">
                <summary>Run provenance</summary>
                <div>
                  {bundle.disclosure.map((text, i) => (
                    <p key={i}>{text}</p>
                  ))}
                  <p>
                    Run: {bundle.runId} · Seed: {bundle.seed}
                  </p>
                  <p>
                    Content hash: <code>{bundle.contentHash}</code>
                  </p>
                  {bundle.stopReason && <p>Stopped: {bundle.stopReason}</p>}
                  <p>
                    Finished:{" "}
                    {bundle.finishedAt
                      ? date(bundle.finishedAt)
                      : "Not recorded"}
                  </p>
                </div>
              </details>
            </div>
            {screen === "overview" ? (
              <Overview bundle={bundle} comparison={comparison} all={all} />
            ) : screen === "queue" ? (
              <Queue key={bundle.runId} bundle={bundle} />
            ) : screen === "beliefs" ? (
              <Beliefs key={bundle.runId} bundle={bundle} />
            ) : screen === "probes" ? (
              <ProbeLog key={bundle.runId} bundle={bundle} />
            ) : screen === "comparison" ? (
              <Comparison bundle={bundle} comparison={comparison} />
            ) : screen === "economics" ? (
              <Economics bundle={bundle} comparison={comparison} />
            ) : (
              <Evidence all={all} />
            )}
            <footer className="page-footer">
              <span>Notary · Evidence before action.</span>
              <span>
                {fixture ? "Fixture data" : "Recorded live data"} ·
                Browser-verified integrity
              </span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
