import { useEffect, useState } from "react";
import { ArrowsClockwiseIcon as ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ChartBarIcon as ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CoinsIcon as Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { FingerprintIcon as Fingerprint } from "@phosphor-icons/react/dist/csr/Fingerprint";
import { FlaskIcon as Flask } from "@phosphor-icons/react/dist/csr/Flask";
import { ListChecksIcon as ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
import { MoonIcon as Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { SunIcon as Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import type { BundleIndexEntry, RunBundle } from "../../core/src/schema";
import { Beliefs } from "./Beliefs";
import { Queue } from "./Queue";
import { Empty, Status } from "./components";
import { date, label, loadBundle, loadIndex, number, percent } from "./data";

const screens = [
  {
    name: "Queue",
    icon: ListChecks,
    description: "Every money action, accountable.",
  },
  {
    name: "Beliefs",
    icon: Fingerprint,
    description: "Trust earned through evidence.",
  },
  {
    name: "Probe log",
    icon: Flask,
    description: "Predictions first. Observations second.",
  },
  {
    name: "Runs comparison",
    icon: ChartBar,
    description: "Measure what changed across runs.",
  },
  { name: "Economics", icon: Coins, description: "The cost of earning trust." },
  {
    name: "Evidence",
    icon: ShieldCheck,
    description: "Receipts behind the demonstration.",
  },
] as const;

export default function App() {
  const [screen, setScreen] = useState<string>("Queue");
  const [index, setIndex] = useState<BundleIndexEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [bundle, setBundle] = useState<RunBundle>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setBundle(undefined);
    loadIndex(controller.signal)
      .then((entries) => {
        if (controller.signal.aborted) return;
        setIndex(entries);
        setSelected((current) =>
          entries.some((entry) => entry.runId === current)
            ? current
            : (entries[0]?.runId ?? ""),
        );
        if (!entries.length) setLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setIndex([]);
          setError(String(error.message));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    const entry = index.find((entry) => entry.runId === selected);
    if (!entry) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setBundle(undefined);
    loadBundle(entry, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setBundle(value);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(String(error.message));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [index, selected]);
  const current = screens.find((item) => item.name === screen)!;
  const fixture =
    bundle?.sample ?? index.find((entry) => entry.runId === selected)?.sample;
  const metric = (key: string, ratio = false) =>
    bundle?.metrics[key] == null
      ? "Not computable"
      : ratio
        ? percent(bundle.metrics[key]!)
        : number(bundle.metrics[key]!);
  return (
    <div className="app-shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <a className="brand" href="#" onClick={() => setScreen("Queue")}>
          <span className="brand-mark">
            <ShieldCheck size={24} weight="bold" aria-hidden="true" />
          </span>
          notary<span className="brand-period">.</span>
        </a>
        <p className="workspace-label">Evidence workspace</p>
        <nav aria-label="Dashboard screens">
          {screens.map((item) => (
            <button
              key={item.name}
              aria-current={screen === item.name ? "page" : undefined}
              className={screen === item.name ? "active" : ""}
              onClick={() => setScreen(item.name)}
            >
              <item.icon size={19} aria-hidden="true" />
              {item.name}
              {item.name === "Queue" && bundle && (
                <span className="nav-count">{number(bundle.queue.length)}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={22} aria-hidden="true" />
          <strong>Evidence before action.</strong>
          <p>
            Inspect the decisions.
            <br />
            Follow the receipts.
          </p>
          <span className="read-only">Read-only workspace</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{screen}</strong>
          </div>
          <div className="topbar-actions">
            <span className="static-mode">Static bundles</span>
            <button
              className="icon-button"
              aria-label={
                dark ? "Switch to light theme" : "Switch to dark theme"
              }
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={19} /> : <Moon size={19} />}
            </button>
          </div>
        </header>
        <main id="main">
          <div className="page-heading">
            <div>
              <span className="eyebrow">Notary / Billing operations</span>
              <h1>{screen}</h1>
              <p>{current.description}</p>
            </div>
            <div className="run-controls">
              <label htmlFor="run">Selected bundle</label>
              <div>
                <select
                  id="run"
                  disabled={!index.length}
                  value={selected}
                  onChange={(event) => {
                    setBundle(undefined);
                    setLoading(true);
                    setSelected(event.target.value);
                  }}
                >
                  <option value="" disabled>
                    {index.length ? "Select a bundle" : "No bundles available"}
                  </option>
                  {index.map((entry) => (
                    <option key={entry.runId} value={entry.runId}>
                      {entry.runId} · {entry.sample ? "Fixture" : "Live data"} ·{" "}
                      {label(entry.variant)}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  aria-label="Reload bundles"
                  onClick={() => setReload((value) => value + 1)}
                >
                  <ArrowsClockwise size={18} />
                </button>
              </div>
            </div>
          </div>
          {fixture && (
            <div className="fixture-banner" role="note">
              <WarningCircle size={20} aria-hidden="true" />
              <strong>Fixture data — simulated APIs, not a live run</strong>
            </div>
          )}
          {error ? (
            <div className="error" role="alert">
              <WarningCircle size={26} aria-hidden="true" />
              <h2>Bundle unavailable</h2>
              <p>{error}</p>
              <button onClick={() => setReload((value) => value + 1)}>
                Retry loading
              </button>
            </div>
          ) : loading ? (
            <div className="loading" role="status">
              <ArrowsClockwise size={24} aria-hidden="true" />
              <h2>Verifying bundle integrity…</h2>
              <p>
                Checking the shared schema and recomputing the content hash.
              </p>
            </div>
          ) : !bundle ? (
            <Empty title="No bundles published">
              Add verified run exports to public/bundles and list them in
              index.json.
            </Empty>
          ) : (
            <>
              <div className="run-receipt">
                <div>
                  <CheckCircle size={17} aria-hidden="true" />
                  <strong>Hash verified</strong>
                  <code title={bundle.contentHash}>
                    {bundle.contentHash.slice(0, 12)}…
                  </code>
                </div>
                <span>
                  {bundle.kind} / {bundle.variant} / {bundle.mode}
                </span>
                <Status value={bundle.status} />
                <span>{date(bundle.startedAt)} IST</span>
              </div>
              <details className="disclosures">
                <summary>Run disclosures & provenance</summary>
                {bundle.disclosure.map((text, index) => (
                  <p key={index}>{text}</p>
                ))}
                {bundle.stopReason && <p>Stopped: {bundle.stopReason}</p>}
                <p>
                  Run: <code>{bundle.runId}</code> · Seed: {bundle.seed}
                </p>
                <p>
                  Finished:{" "}
                  {bundle.finishedAt ? date(bundle.finishedAt) : "Not recorded"}
                  {bundle.tool && ` · Tool: ${bundle.tool}`}
                  {bundle.priorsFrom && ` · Priors from: ${bundle.priorsFrom}`}
                  {bundle.replayOf && ` · Replay of: ${bundle.replayOf}`}
                </p>
                <p>
                  Content hash: <code>{bundle.contentHash}</code>
                </p>
                <p>
                  Cassettes: {bundle.cassettes.join(", ") || "None recorded"}
                </p>
              </details>
              <div className="metrics">
                <div>
                  <span>Unsafe actions</span>
                  <strong>{metric("unsafe_actions_total")}</strong>
                  <small>Deterministic grading</small>
                </div>
                <div>
                  <span>Decision accuracy</span>
                  <strong>{metric("decision_accuracy", true)}</strong>
                  <small>Against expected outcomes</small>
                </div>
                <div>
                  <span>Automation rate</span>
                  <strong>{metric("automation_rate", true)}</strong>
                  <small>Recorded run metric</small>
                </div>
                <div>
                  <span>Credits consumed</span>
                  <strong>
                    {number(bundle.credits.total)}
                    <small> / {number(bundle.credits.budget)}</small>
                  </strong>
                  <small>Run credit budget</small>
                </div>
              </div>
              {screen === "Queue" ? (
                <Queue key={bundle.runId} bundle={bundle} />
              ) : screen === "Beliefs" ? (
                <Beliefs key={bundle.runId} bundle={bundle} />
              ) : (
                <Empty title={`${screen} is scheduled`}>
                  {screen === "Probe log" || screen === "Runs comparison"
                    ? "This screen will be implemented in the next dashboard phase."
                    : "This screen will be implemented in the economics and evidence phase."}
                </Empty>
              )}
              <footer className="page-footer">
                <span>Notary · Evidence before action</span>
                <span>
                  {fixture ? "Fixture bundle" : "Recorded run bundle"} ·
                  Browser-verified integrity
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
