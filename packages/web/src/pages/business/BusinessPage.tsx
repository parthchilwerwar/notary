// /app/business: what Notary costs to run and the business modeled on it in cfo.ai. Two sources,
// always labeled and never mixed in one chart: "Computed from runs" (real bundles, sample:false,
// via `pnpm notary economics`) and "Modeled in cfo.ai" (the plan imported with --cfo-import,
// exactly as exported). Everything comes from public/economics.json, validated and hash-checked
// in this browser. No fixture data is ever shown here, so the fixture header note is suppressed.
import { useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowSquareOut, Calculator, ChartLineUp, DownloadSimple, Terminal } from "@phosphor-icons/react";
import type { CfoPlan, EconomicsComputed, EconomicsFile, EconomicsRatio } from "../../../../core/src/schema";
import {
  Button,
  EmptyState,
  Expander,
  Facts,
  Page,
  PageBody,
  PageHeader,
  PageHeaderContext,
  PageSkeleton,
  Section,
  Stat,
  StatRow,
  TableFrame,
  usePageMotion,
} from "../../ui";
import { CFO_IMPORT_COMMAND, ECONOMICS_COMMAND, ECONOMICS_FILE, loadEconomics, type EconomicsState } from "../../data/economics";
import { BarList, ColumnChart, DataTable, Legend, LineChart } from "./charts";
import {
  CFO_STEPS,
  PLAN_FIGURES,
  PLAN_SERIES,
  alignSeries,
  certificateBars,
  cfoInputsCsv,
  compact,
  costPerRunSeries,
  count,
  endpointBars,
  figureOf,
  money,
  otherSeries,
  planValue,
  roleBars,
  seriesOf,
} from "./model";
import "./business.css";

export const CFO_URL = "https://cfo.ai";

type Load = { status: "loading" } | EconomicsState | { status: "error"; error: string };

/** The page body for a loaded state (exported for tests: renders from data alone). */
export function BusinessView({ state }: { state: Load }) {
  const file = state.status === "ready" ? state.file : undefined;
  const summary = !file
    ? "Unit economics from real runs, and the business plan modeled in cfo.ai"
    : [
        file.computed ? `${file.computed.totals.liveRuns} live real run${file.computed.totals.liveRuns === 1 ? "" : "s"} costed` : "No real runs costed yet",
        file.plan ? `plan modeled in cfo.ai, imported ${dateOnly(file.plan.source.importedAt)}` : "cfo.ai plan not imported yet",
      ].join(" · ");
  return (
    <>
      <PageHeader
        title="Business"
        summary={summary}
        action={
          file ? (
            <Button asChild variant="secondary">
              <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(cfoInputsCsv(file))}`} download="cfo-inputs.csv">
                <DownloadSimple size={16} aria-hidden="true" /> Inputs for cfo.ai
              </a>
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        {state.status === "loading" ? null : state.status === "missing" ? (
          <EmptyState title="No economics published yet">
            <p>
              <code>{ECONOMICS_FILE}</code> does not exist. Write it from the real run bundles: <Cmd>{ECONOMICS_COMMAND}</Cmd>
            </p>
            <p>Then import your cfo.ai plan: <Cmd>{CFO_IMPORT_COMMAND}</Cmd></p>
          </EmptyState>
        ) : state.status === "invalid" || state.status === "error" ? (
          <EmptyState tone="error" title="Economics withheld">
            <p>{state.error}</p>
            <p>
              Regenerate it with <Cmd>{ECONOMICS_COMMAND}</Cmd>
            </p>
          </EmptyState>
        ) : (
          <Ready file={state.file} />
        )}
      </PageBody>
    </>
  );
}

export function BusinessPage() {
  const [state, setState] = useState<Load>({ status: "loading" });
  const header = useContext(PageHeaderContext);
  useEffect(() => {
    const controller = new AbortController();
    loadEconomics(controller.signal).then(
      (s) => !controller.signal.aborted && setState(s),
      (e: Error) => !controller.signal.aborted && setState({ status: "error", error: e.message }),
    );
    return () => controller.abort();
  }, []);
  const root = usePageMotion([state.status]);
  if (state.status === "loading") return <PageSkeleton label="Verifying the published economics…" stats={4} />;
  return (
    // Real data only: the shell's fixture note (about the selected run) does not apply here.
    <PageHeaderContext.Provider value={{ ...header, note: undefined }}>
      <Page ref={root} className="business">
        <BusinessView state={state} />
      </Page>
    </PageHeaderContext.Provider>
  );
}

// ------------------------------------------------------------------------------------ pieces

const dateOnly = (iso: string) => iso.slice(0, 10);

/** The first sentence of a reason, without command detail (the full reason is in its section). */
function shortReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  if (/predates|counted bundle/.test(reason)) return "The certificates report is older than the newest notarize run";
  const first = reason.split(/(?<=\.)\s/)[0]!.replace(/`/g, "");
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
}

function Cmd({ children }: { children: ReactNode }) {
  return (
    <code className="biz-cmd">
      <Terminal size={14} aria-hidden="true" />
      {children}
    </code>
  );
}

/** Text from the file with `code` spans (reasons name commands in backticks). */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : part))}
    </>
  );
}

/** The two-source key every section points back to. */
function SourceTag({ kind }: { kind: "computed" | "cfo" }) {
  return kind === "computed" ? (
    <span className="biz-source" data-kind="computed">
      <Calculator size={14} aria-hidden="true" /> Computed from runs
    </span>
  ) : (
    <span className="biz-source" data-kind="cfo">
      <ChartLineUp size={14} aria-hidden="true" /> Modeled in cfo.ai
    </span>
  );
}

function ratioStat(label: string, r: EconomicsRatio | undefined, reasonIfNoData: string) {
  if (!r) return <Stat label={label} value={null} note={reasonIfNoData} />;
  return (
    <Stat
      label={label}
      value={r.usd}
      display={r.usd === null ? undefined : money(r.usd)}
      note={r.usd === null ? shortReason(r.reason) : r.credits ? `+ ${count(r.credits)} Crustdata credits` : "no Crustdata credits"}
    />
  );
}

function Ready({ file }: { file: EconomicsFile }) {
  const c = file.computed;
  const noRuns = file.computedReason ?? "";
  return (
    <>
      <div className="biz-key-line" data-reveal>
        <p>
          <SourceTag kind="computed" /> figures are recomputed from {file.sources.bundles.length} real run bundle{file.sources.bundles.length === 1 ? "" : "s"} (fixture runs are never
          counted). <SourceTag kind="cfo" /> figures are the business plan built in{" "}
          <a href={CFO_URL} target="_blank" rel="noreferrer">
            cfo.ai
          </a>
          , shown exactly as exported. The two are never mixed in one chart.
        </p>
      </div>
      <StatRow label="Unit economics from real runs">
        {ratioStat("Cost per run", c?.costPerRun, shortReason(noRuns) ?? "")}
        {ratioStat("Cost per notarized belief", c?.costPerNotarizedBelief, shortReason(noRuns) ?? "")}
        {ratioStat("Cost per certificate", c?.costPerCertificate, shortReason(noRuns) ?? "")}
        <Stat label="Unsafe actions prevented" value={c?.unsafeActionsPrevented.value ?? null} note={c ? (c.unsafeActionsPrevented.value === null ? "Needs a live naive and guarded run of one queue" : "naive minus guarded, same queue") : shortReason(noRuns)} />
        <Stat label="Held for a person" value={c?.heldActions.value ?? null} note={c ? (c.heldActions.value === null ? "Needs a live guarded queue run" : "money actions held, not executed") : shortReason(noRuns)} />
      </StatRow>
      {c ? <Computed c={c} /> : (
        <Section label={<SourceTag kind="computed" />} title="Cost of running Notary">
          <EmptyState title="No real runs to cost yet">
            <p>
              <Prose text={file.computedReason ?? ""} />
            </p>
          </EmptyState>
        </Section>
      )}
      <Plan file={file} />
      <RoundTrip file={file} />
      <Sources file={file} />
    </>
  );
}

// ---------------------------------------------------------------------------- computed section

function Computed({ c }: { c: EconomicsComputed }) {
  const runs = costPerRunSeries(c);
  const roles = roleBars(c);
  const endpoints = endpointBars(c);
  const certs = certificateBars(c);
  return (
    <>
      <Section
        id="cost-per-run"
        label={<SourceTag kind="computed" />}
        title="Cost per run over time"
        description={`Model USD and Crustdata credits of each live real run. ${c.totals.replayRuns ? `${c.totals.replayRuns} replay${c.totals.replayRuns === 1 ? "" : "s"} left out (they spend nothing). ` : ""}Credits have no USD price, so they are charted separately.`}
      >
        {runs.usd.length ? (
          <div className="biz-multiples">
            <figure className="biz-figure" data-reveal>
              <figcaption className="biz-figcap">Model USD per run</figcaption>
              <ColumnChart data={runs.usd} label="Model USD per live run, oldest first" format={(n) => money(n)} />
            </figure>
            <figure className="biz-figure" data-reveal>
              <figcaption className="biz-figcap">Crustdata credits per run</figcaption>
              <ColumnChart data={runs.credits} label="Crustdata credits per live run, oldest first" format={compact} />
            </figure>
          </div>
        ) : (
          <EmptyState title="No live real run yet">
            <p>
              <Prose text={c.costPerRun.reason ?? ""} />
            </p>
          </EmptyState>
        )}
        <DataTable
          caption="Every real run"
          head={["#", "Run", "Mode", "Model USD", "Tokens", "Credits", "Unsafe", "Held"]}
          rows={c.runs.map((r, i) => [String(i + 1), <code key="r">{r.runId}</code>, r.mode, money(r.modelUsd), count(r.tokens), count(r.credits), r.unsafeActions ?? "—", r.holds ?? "—"])}
        />
      </Section>

      <div className="biz-two">
        <Section id="usd-by-role" label={<SourceTag kind="computed" />} title="Model USD by role" description="Live spend of each model role: the executor acts, the reflector proposes, the adversary reviews.">
          {c.totals.modelUsd > 0 ? <BarList data={roles} label="Model USD by role" /> : <p className="biz-note">No model spend recorded in live runs.</p>}
        </Section>
        <Section id="credits-by-endpoint" label={<SourceTag kind="computed" />} title="Credits by endpoint" description="Crustdata credits charged per endpoint across live runs.">
          {endpoints.length ? <BarList data={endpoints} label="Crustdata credits by endpoint" /> : <p className="biz-note">No Crustdata endpoint was called in a live run.</p>}
        </Section>
      </div>

      <Section id="cost-per-certificate" label={<SourceTag kind="computed" />} title="Cost per certificate" description={c.costPerCertificate.basis}>
        {certs.length ? (
          <BarList data={certs} label="Model USD per certificate, by tool" />
        ) : (
          <EmptyState title="No certificate to divide by yet">
            <p>
              <Prose text={c.costPerCertificate.reason ?? ""} />
            </p>
          </EmptyState>
        )}
        <TableFrame>
          <table>
            <caption className="sr-only">Notarize spend and what it bought, by tool</caption>
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Live notarize runs</th>
                <th scope="col">Model USD</th>
                <th scope="col">Credits</th>
                <th scope="col">Notarized beliefs</th>
                <th scope="col">Certified</th>
              </tr>
            </thead>
            <tbody>
              {c.tools.map((t) => (
                <tr key={t.tool}>
                  <th scope="row">{t.tool === "dodo" ? "Dodo Payments" : "Crustdata"}</th>
                  <td>{t.runs}</td>
                  <td>{money(t.modelUsd)}</td>
                  <td>{count(t.credits)}</td>
                  <td>{t.notarizedBeliefs ?? "—"}</td>
                  <td>{t.certified ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      </Section>

      <Section id="prevented" label={<SourceTag kind="computed" />} title="What the guard prevented" description={c.unsafeActionsPrevented.basis.replace(/`/g, "")}>
        {c.pairs.length ? (
          <TableFrame>
            <table>
              <caption className="sr-only">Naive vs guarded live runs per world</caption>
              <thead>
                <tr>
                  <th scope="col">World (seed)</th>
                  <th scope="col">Unsafe without Notary</th>
                  <th scope="col">Unsafe with Notary</th>
                  <th scope="col">Prevented</th>
                  <th scope="col">Held for a person</th>
                </tr>
              </thead>
              <tbody>
                {c.pairs.map((p) => (
                  <tr key={p.seed}>
                    <th scope="row">
                      {p.seed} · <code>{p.naiveRunId}</code> vs <code>{p.guardedRunId}</code>
                    </th>
                    <td>{p.naiveUnsafe ?? "—"}</td>
                    <td>{p.guardedUnsafe ?? "—"}</td>
                    <td>{p.prevented ?? "—"}</td>
                    <td>{p.held ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        ) : (
          <EmptyState title="No naive and guarded pair yet">
            <p>
              <Prose text={c.unsafeActionsPrevented.reason ?? ""} />
            </p>
          </EmptyState>
        )}
      </Section>
    </>
  );
}

// -------------------------------------------------------------------------------- cfo.ai plan

function Attribution({ plan }: { plan: CfoPlan | null }) {
  return (
    <p className="biz-attrib">
      <ChartLineUp size={16} aria-hidden="true" />
      <span>
        Modeled in{" "}
        <a href={CFO_URL} target="_blank" rel="noreferrer">
          cfo.ai <ArrowSquareOut size={12} aria-hidden="true" />
        </a>
        {plan?.source.shareUrl && (
          <>
            {" · "}
            <a href={plan.source.shareUrl} target="_blank" rel="noreferrer">
              Open the plan in cfo.ai <ArrowSquareOut size={12} aria-hidden="true" />
            </a>
          </>
        )}
      </span>
    </p>
  );
}

function Plan({ file }: { file: EconomicsFile }) {
  const plan = file.plan;
  if (!plan)
    return (
      <Section id="plan" label={<SourceTag kind="cfo" />} title="The business plan" description="Pricing per monitored API contract, COGS, the cost of incidents prevented, runway and a revenue projection, built in cfo.ai from Notary's real costs.">
        <Attribution plan={null} />
        <EmptyState title="Import your cfo.ai plan">
          {file.planReason && !file.planReason.includes("--cfo-import <file>") ? (
            <p>
              <Prose text={file.planReason} />
            </p>
          ) : (
            <p>No cfo.ai plan has been imported yet.</p>
          )}
          <p>
            <Cmd>{CFO_IMPORT_COMMAND}</Cmd>
          </p>
          <p>The steps below build it in cfo.ai from the inputs sheet of real runs.</p>
        </EmptyState>
      </Section>
    );
  const s = plan.source;
  const revenue = seriesOf(plan, PLAN_SERIES.revenue);
  const cogs = seriesOf(plan, PLAN_SERIES.cogs);
  const cash = seriesOf(plan, PLAN_SERIES.cash);
  const headline = PLAN_FIGURES.flatMap((k) => {
    const f = figureOf(plan, k);
    return f ? [f] : [];
  });
  const others = plan.figures.filter((f) => !(PLAN_FIGURES as readonly string[]).includes(f.key));
  const extraSeries = otherSeries(plan);
  const maxTier = Math.max(0, ...plan.tiers.map((t) => t.price));
  return (
    <>
      <Section id="plan" label={<SourceTag kind="cfo" />} title="The business plan" description="As exported from cfo.ai: nothing here is recomputed, rounded or filled in.">
        <Attribution plan={plan} />
        <Facts
          columns={3}
          items={[
            { key: "ws", label: "Workspace", value: s.workspace ?? "Not stated in the export" },
            { key: "page", label: "Page · scenario", value: [s.page, s.scenario].filter(Boolean).join(" · ") || "Not stated in the export" },
            { key: "imp", label: "Imported", value: `${s.importedAt.replace("T", " ").slice(0, 16)} UTC${s.exportedAt ? ` (exported ${s.exportedAt})` : ""}` },
            { key: "file", label: "File", value: <code>{s.file}</code> },
            { key: "sha", label: "sha256", value: <code className="biz-hash">{s.fileSha256}</code>, wide: true },
          ]}
        />
        {headline.length > 0 && (
          <StatRow label="Key figures from the cfo.ai plan">
            {headline.map((f) => (
              <Stat key={f.key} label={f.label} value={f.value} display={planValue(f.value, f.unit)} note={f.detail ?? undefined} />
            ))}
          </StatRow>
        )}
      </Section>

      <Section id="plan-revenue" label={<SourceTag kind="cfo" />} title="Revenue vs COGS" description={revenue && cogs ? `${revenue.label} and ${cogs.label} by period, ${revenue.unit || "as exported"}.` : undefined}>
        {revenue && cogs && revenue.unit === cogs.unit ? (
          (() => {
            const al = alignSeries(revenue, cogs);
            const fmt = (n: number) => planValue(n, revenue.unit);
            return (
              <figure className="biz-figure" data-reveal>
                <Legend items={[{ key: "rev", label: revenue.label, tone: "primary" }, { key: "cogs", label: cogs.label, tone: "secondary" }]} />
                <LineChart
                  periods={al.periods}
                  series={[
                    { key: "rev", label: revenue.label, tone: "primary", values: al.a },
                    { key: "cogs", label: cogs.label, tone: "secondary", values: al.b },
                  ]}
                  label={`${revenue.label} and ${cogs.label} by period`}
                  format={(n) => (/^[A-Z]{3}$/.test(revenue.unit) ? `${compact(n)}` : fmt(n))}
                />
                <DataTable caption="Revenue and COGS by period" head={["Period", revenue.label, cogs.label]} rows={al.periods.map((p, i) => [p, al.a[i] === null ? "—" : fmt(al.a[i]!), al.b[i] === null ? "—" : fmt(al.b[i]!)])} />
              </figure>
            );
          })()
        ) : (
          <p className="biz-note">
            The imported plan has no {revenue ? "" : "`revenue`"}
            {!revenue && !cogs ? " and no " : ""}
            {cogs ? "" : "`cogs`"} series{revenue && cogs ? " in one unit" : ""}. Add <code>series,revenue,…</code> and <code>series,cogs,…</code> rows to the export and re-import.
          </p>
        )}
      </Section>

      <Section id="plan-runway" label={<SourceTag kind="cfo" />} title="Cash and runway" description={figureOf(plan, "runway_months") ? `Runway in the plan: ${planValue(figureOf(plan, "runway_months")!.value, figureOf(plan, "runway_months")!.unit)}.` : undefined}>
        {cash ? (
          <figure className="biz-figure" data-reveal>
            <figcaption className="biz-figcap">
              {cash.label}
              {cash.unit ? ` (${cash.unit})` : ""}
            </figcaption>
            <LineChart periods={cash.points.map((p) => p.period)} series={[{ key: "cash", label: cash.label, tone: "primary", values: cash.points.map((p) => p.value) }]} label={`${cash.label} by period`} format={compact} />
            <DataTable caption={`${cash.label} by period`} head={["Period", cash.label]} rows={cash.points.map((p) => [p.period, planValue(p.value, cash.unit)])} />
          </figure>
        ) : (
          <p className="biz-note">
            The imported plan has no <code>cash</code> series. Add <code>series,cash,…</code> rows (and a <code>figure,runway_months,…</code> row) to the export and re-import.
          </p>
        )}
      </Section>

      <Section id="plan-pricing" label={<SourceTag kind="cfo" />} title="Pricing per monitored API contract">
        {plan.tiers.length ? (
          <ol className="biz-tiers">
            {plan.tiers.map((t) => (
              <li key={t.key} className="biz-tier" data-reveal>
                <h3 className="biz-tier-name">{t.name}</h3>
                <p className="biz-tier-price">
                  <span className="num-display">{money(t.price, t.currency)}</span> <span className="biz-tier-per">/ {t.period}</span>
                </p>
                <span className="biz-tier-meter" aria-hidden="true">
                  <span style={{ width: maxTier > 0 ? `${(t.price / maxTier) * 100}%` : "0%" }} />
                </span>
                {t.description && <p className="biz-tier-desc">{t.description}</p>}
                {t.features.length > 0 && (
                  <ul className="biz-tier-features">
                    {t.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="biz-note">
            The imported plan has no pricing tiers. Add <code>tier,…</code> rows to the export and re-import.
          </p>
        )}
      </Section>

      {(others.length > 0 || extraSeries.length > 0) && (
        <Section id="plan-other" label={<SourceTag kind="cfo" />} title="Everything else in the plan">
          <TableFrame>
            <table>
              <caption className="sr-only">Other figures and series in the cfo.ai plan</caption>
              <thead>
                <tr>
                  <th scope="col">Figure</th>
                  <th scope="col">Value</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {others.map((f) => (
                  <tr key={f.key}>
                    <th scope="row">{f.label}</th>
                    <td>{planValue(f.value, f.unit)}</td>
                    <td>{f.detail ?? ""}</td>
                  </tr>
                ))}
                {extraSeries.map((sr) => (
                  <tr key={sr.key}>
                    <th scope="row">{sr.label}</th>
                    <td>{sr.points.map((p) => `${p.period}: ${planValue(p.value, sr.unit)}`).join(" · ")}</td>
                    <td>series</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </Section>
      )}

      {file.combined.incidentsPreventedValue && (
        <Section id="combined" title="Value of unsafe actions prevented" description="The one figure that needs both sources, labeled as such.">
          <StatRow label="Computed × cfo.ai">
            <Stat label="Prevented × cost per incident" value={file.combined.incidentsPreventedValue.value} display={planValue(file.combined.incidentsPreventedValue.value, file.combined.incidentsPreventedValue.unit)} note={file.combined.incidentsPreventedValue.basis} />
          </StatRow>
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------------------- the cfo.ai round trip

function RoundTrip({ file }: { file: EconomicsFile }) {
  return (
    <Section
      id="cfo-steps"
      label={<SourceTag kind="cfo" />}
      title="Build the plan in cfo.ai"
      description="cfo.ai has no REST API or API key. Real costs go in as a CSV data source; the plan comes back as a file Ari produces (or over its MCP server)."
      actions={
        <Button asChild variant="secondary" size="sm">
          <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(cfoInputsCsv(file))}`} download="cfo-inputs.csv">
            <DownloadSimple size={14} aria-hidden="true" /> cfo-inputs.csv ({file.computed?.runs.length ?? 0} runs)
          </a>
        </Button>
      }
    >
      <ol className="biz-steps">
        {CFO_STEPS.map((step, i) => (
          <li key={step.title} className="biz-step" data-reveal>
            <span className="biz-step-n num-display">{i + 1}</span>
            <div>
              <h3 className="biz-step-title">{step.title}</h3>
              <p className="biz-step-body">{step.body}</p>
              {step.command && <Cmd>{step.command}</Cmd>}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Sources({ file }: { file: EconomicsFile }) {
  return (
    <Section id="sources" title="Sources" description={`Hash-checked in this browser: contentHash ${file.contentHash.slice(0, 16)}…`}>
      <Expander summary={`${file.sources.bundles.length} bundles used · ${file.sources.skipped.length} files skipped`}>
        <TableFrame>
          <table>
            <caption className="sr-only">Files the economics read</caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Used</th>
              </tr>
            </thead>
            <tbody>
              {file.sources.bundles.map((b) => (
                <tr key={b.file}>
                  <th scope="row">
                    <code>{b.file}</code>
                  </th>
                  <td>yes · {b.contentHash.slice(0, 12)}</td>
                </tr>
              ))}
              {file.sources.skipped.map((b) => (
                <tr key={b.file}>
                  <th scope="row">
                    <code>{b.file}</code>
                  </th>
                  <td>no · {b.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      </Expander>
    </Section>
  );
}
