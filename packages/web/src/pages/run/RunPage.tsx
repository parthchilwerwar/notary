// /app/run — one run as an agent transcript: the events of the run streamed in order (SSE from a
// local `notary serve`, or the recorded timeline replayed at 1×, 4× or instant), each a compact
// row that expands into tagged details, held actions inline, the five-step progress bar, the
// budget, and the certificates the run touched. All data comes through useDataSource(); all
// logic lives in ./model.ts.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ApprovalsList, PendingApproval, RunBundle, TimelineEvent } from "../../../../core/src/schema";
import {
  Button,
  Card,
  CertificateCard,
  EmptyState,
  Page,
  PageBody,
  PageSkeleton,
  Select,
  SkyBand,
  Stat,
  StatRow,
  usePageMotion,
} from "../../ui";
import { worldMatches } from "../../components/trail/model";
import {
  LocalApiError,
  RunStillRunningError,
  TimelineMissingError,
  TOKEN_REQUIRED,
  toCertificateView,
  useDataSource,
  useIntegration,
  useSessionToken,
  number,
  type CertificateView,
  type RunEntry,
} from "../../data";
import { ConfirmDialog, type DialogKind } from "../approvals/ConfirmDialog";
import {
  INITIAL_FOLLOW,
  REPLAY_SPEEDS,
  START_CHOICES,
  afterRowsAdded,
  afterScroll,
  budgetView,
  buildRows,
  certificatesTouched,
  groupRuns,
  heldCard,
  indexBundle,
  isFinished,
  jumpToLatest,
  mergeEvents,
  parseSpeed,
  pickRun,
  rowDetails,
  runControls,
  runLabel,
  speedLabel,
  stageProgress,
  unsafeDecisionIds,
  type FollowState,
  type RunRow,
  type Speed,
  type StageStep,
  type TouchedCertificate,
} from "./model";
import { CodeText, HeldCardView, RowDetailsView, StatusMark, TranscriptRow } from "./Transcript";
import "./run.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ENTER_MS = 400;

type BundleState = { runId: string; bundle?: RunBundle; running?: boolean; error?: string };

export function RunPage() {
  const { source, mode, ready } = useDataSource();
  const [params, setParams] = useSearchParams();
  const [token, setToken] = useSessionToken();

  /* ---- runs ---- */
  const [runs, setRuns] = useState<RunEntry[] | null>(null);
  const [runsError, setRunsError] = useState<string>();
  const [runsNonce, setRunsNonce] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    source.listRuns(ctrl.signal).then(
      (r) => {
        setRuns(r);
        setRunsError(undefined);
      },
      (e) => !ctrl.signal.aborted && setRunsError(message(e)),
    );
    return () => ctrl.abort();
  }, [ready, source, runsNonce]);

  const entry = runs ? pickRun(runs, params.get("run")) : undefined;
  const runId = entry?.runId;
  const requestedMissing = !!runs && !!params.get("run") && entry?.runId !== params.get("run");
  const speed = parseSpeed(params.get("speed"));
  const controls = runControls(mode, entry);

  const setParam = useCallback(
    (key: string, value: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: key !== "run" },
      ),
    [setParams],
  );

  /* ---- bundle ---- */
  const [bundleState, setBundleState] = useState<BundleState>();
  const [bundleNonce, setBundleNonce] = useState(0);
  useEffect(() => {
    if (!ready || !entry) return;
    const id = entry.runId;
    if (entry.state === "running") {
      setBundleState({ runId: id, running: true });
      return;
    }
    const ctrl = new AbortController();
    setBundleState((prev) => (prev?.runId === id ? prev : { runId: id }));
    source.getRun(id, ctrl.signal).then(
      (bundle) => setBundleState({ runId: id, bundle }),
      (e) => {
        if (ctrl.signal.aborted) return;
        if (e instanceof RunStillRunningError) setBundleState({ runId: id, running: true });
        else setBundleState({ runId: id, error: message(e) });
      },
    );
    return () => ctrl.abort();
    // entry identity changes on every list refresh; the run id and state are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, source, entry?.runId, entry?.state, bundleNonce]);
  const bundle = bundleState?.runId === runId ? bundleState?.bundle : undefined;
  const index = useMemo(() => (bundle ? indexBundle(bundle) : undefined), [bundle]);

  /* ---- certificate world (same world as the run, never another) ---- */
  const [world, setWorld] = useState<{ runId: string; view: CertificateView | null; error?: string }>();
  useEffect(() => {
    if (!ready || !entry || entry.state !== "finished") return;
    const ctrl = new AbortController();
    source.certificates(entry, ctrl.signal).then(
      (w) => setWorld({ runId: entry.runId, view: toCertificateView(w) }),
      (e) => !ctrl.signal.aborted && setWorld({ runId: entry.runId, view: null, error: message(e) }),
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, source, entry?.runId, entry?.state]);
  const worldView = world && world.runId === runId && world.view && (!bundle || worldMatches(world.view, bundle)) ? world.view : null;

  /* ---- event stream ---- */
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [ended, setEnded] = useState(false);
  const [streamError, setStreamError] = useState<string>();
  const [replayNonce, setReplayNonce] = useState(0);
  const arrivals = useRef(new Map<number, number>());
  const streamSpeed: Speed | undefined = controls.speed.visible ? speed : undefined;
  useEffect(() => {
    if (!ready || !runId) return;
    setEvents([]);
    setEnded(false);
    setStreamError(undefined);
    arrivals.current = new Map();
    let buffer: TimelineEvent[] = [];
    let frame = 0;
    const flush = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      const now = performance.now();
      if (streamSpeed !== "instant") for (const e of batch) if (!arrivals.current.has(e.seq)) arrivals.current.set(e.seq, now);
      setEvents((prev) => mergeEvents(prev, batch, runId));
    };
    const stop = source.streamEvents(
      runId,
      (e) => {
        buffer.push(e);
        if (!frame) frame = requestAnimationFrame(flush);
      },
      {
        speed: streamSpeed,
        onEnd: () => {
          flush();
          setEnded(true);
        },
        onError: (m) => setStreamError(m),
      },
    );
    return () => {
      stop();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ready, source, runId, streamSpeed, replayNonce]);

  // A live run that just finished: its bundle and final list entry now exist.
  const wasRunning = entry?.state === "running" || bundleState?.running;
  useEffect(() => {
    if (ended && wasRunning) {
      setRunsNonce((n) => n + 1);
      setBundleNonce((n) => n + 1);
    }
  }, [ended, wasRunning]);

  const finished = isFinished(events);

  /* ---- approvals (held decisions only) ---- */
  const [approvals, setApprovals] = useState<{ list: ApprovalsList | null; error?: string }>({ list: null });
  const [approvalsNonce, setApprovalsNonce] = useState(0);
  const anyHeld = events.some((e) => e.type === "decision" && e.data?.status === "held");
  useEffect(() => {
    if (!ready || !anyHeld) return;
    const ctrl = new AbortController();
    source.approvals(ctrl.signal).then(
      (list) => setApprovals({ list }),
      (e) => !ctrl.signal.aborted && setApprovals({ list: null, error: message(e) }),
    );
    return () => ctrl.abort();
  }, [ready, source, anyHeld, approvalsNonce, token, finished]);
  const [dialog, setDialog] = useState<{ kind: DialogKind; item: PendingApproval } | null>(null);

  /* ---- rows ---- */
  const rows = useMemo(() => buildRows(events, { bundle, index, world: worldView }), [events, bundle, index, worldView]);
  const progress = useMemo(() => stageProgress(events, unsafeDecisionIds(bundle)), [events, bundle]);
  const budget = useMemo(() => budgetView(events, finished ? bundle?.usageByRole : undefined), [events, finished, bundle]);
  const touched = useMemo(() => certificatesTouched(events, worldView), [events, worldView]);
  const streaming = !!runId && !ended && !streamError;
  const root = usePageMotion([runId]);

  /* ---- expansion + deep links (?event=, ?decision=, ?probe=) ---- */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => setExpanded(new Set()), [runId]);
  const target = params.get("event") ?? params.get("decision") ?? params.get("probe");
  const targetKey = useMemo(() => {
    if (!target) return undefined;
    const hit = rows.find(
      (r) => (r.seq !== null && String(r.seq) === target && params.get("event") === target) || r.event?.recordIds[0] === target,
    );
    return hit?.key;
  }, [rows, target, params]);
  const toggle = (row: RunRow) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });

  /* ---- virtual list + follow ---- */
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTop = useRef(0);
  const [follow, setFollow] = useState<FollowState>(INITIAL_FOLLOW);
  const count = rows.length + (streaming ? 1 : 0);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 10,
    getItemKey: (i) => rows[i]?.key ?? "waiting",
  });
  const prevCount = useRef(0);
  useLayoutEffect(() => {
    const added = rows.length - prevCount.current;
    prevCount.current = rows.length;
    if (added < 0) {
      setFollow(INITIAL_FOLLOW);
      return;
    }
    setFollow((f) => afterRowsAdded(f, added));
  }, [rows.length]);
  useEffect(() => {
    if (follow.follow && count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [count, follow.follow, virtualizer]);
  const appliedTarget = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!targetKey || appliedTarget.current === targetKey) return;
    appliedTarget.current = targetKey;
    setExpanded((prev) => new Set(prev).add(targetKey));
    setFollow({ follow: false, unseen: 0 });
    const i = rows.findIndex((r) => r.key === targetKey);
    if (i >= 0) requestAnimationFrame(() => virtualizer.scrollToIndex(i, { align: "start" }));
  }, [targetKey, rows, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setFollow((f) => afterScroll(f, el, lastTop.current));
    lastTop.current = el.scrollTop;
  };

  /* ---- render ---- */
  if (!ready) return <PageSkeleton label="Choosing live or replay mode…" />;
  const groups = runs ? groupRuns(runs) : { real: [], fixture: [] };
  const now = performance.now();
  const notarize = (entry?.kind ?? bundle?.kind) === "notarize";
  const decisions = events.filter((e) => e.type === "decision");
  const held = decisions.filter((e) => e.data?.status === "held").length;
  const probes = events.filter((e) => e.type === "probe.verdict").length;
  const issued = events.filter((e) => e.type === "certificate.issued").length;
  const statusText = streaming
    ? controls.speed.visible
      ? `replaying at ${speedLabel(speed)}`
      : "streaming from notary serve"
    : ended
      ? finished
        ? "finished"
        : "stream ended"
      : "";
  const summary = runId
    ? `${runId} · ${number(events.length)} ${events.length === 1 ? "event" : "events"}${statusText ? ` · ${statusText}` : ""}`
    : runs && !runs.length
      ? "No runs are published yet"
      : "Choose a run";

  return (
    <Page ref={root} className="run-page">
      <SkyBand
        title="Run"
        summary={summary}
        action={
          <div className="run-actions">
            <label className="run-select">
              <span className="sr-only">Run</span>
              <Select
                value={runId ?? ""}
                disabled={!runs?.length}
                onChange={(e) =>
                  setParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set("run", e.target.value);
                    for (const k of ["event", "decision", "probe"]) next.delete(k);
                    return next;
                  })
                }
              >
                {!runs && <option value="">{runsError ? "Runs withheld" : "Loading runs…"}</option>}
                {runs && !runs.length && <option value="">No runs</option>}
                {groups.real.length > 0 && (
                  <optgroup label={mode === "live" ? "Runs on this machine" : "Recorded runs"}>
                    {groups.real.map((r) => (
                      <option key={r.runId} value={r.runId}>
                        {runLabel(r)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {groups.fixture.length > 0 && (
                  <optgroup label="Fixture runs (simulated APIs)">
                    {groups.fixture.map((r) => (
                      <option key={r.runId} value={r.runId}>
                        {runLabel(r)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </label>
            {controls.start.visible ? (
              <StartRun
                onStarted={(id) => {
                  setRunsNonce((n) => n + 1);
                  setParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set("run", id);
                    return next;
                  });
                }}
                token={token}
                setToken={setToken}
              />
            ) : (
              <p className="run-start-note">
                <CodeText text={controls.start.note ?? ""} />
              </p>
            )}
          </div>
        }
      >
        <StageBar steps={progress.steps} finished={progress.finished} />
      </SkyBand>

      <PageBody>
        {runsError && (
          <EmptyState tone="error" title="Runs withheld">
            <p>The run list could not be read. Re-export with <code>pnpm notary export</code> or restart <code>pnpm notary serve</code>.</p>
            <p className="run-muted">{runsError}</p>
          </EmptyState>
        )}
        {requestedMissing && (
          <p className="run-error" role="alert">
            Run {params.get("run")} is not in this source's run list; showing {runId ?? "nothing"}.
          </p>
        )}
        {bundleState?.runId === runId && bundleState?.error && (
          <EmptyState tone="error" title="Bundle withheld">
            <p>This run's bundle failed its integrity or schema check in this browser, so its records are not shown.</p>
            <p className="run-muted">{bundleState.error}</p>
          </EmptyState>
        )}

        <StatRow label="This run">
          {notarize ? (
            <>
              <Stat label="Probes run" value={probes} display={number(probes)} />
              <Stat label="Certificates issued" value={issued} display={number(issued)} />
            </>
          ) : (
            <>
              <Stat label="Actions processed" value={decisions.length} display={number(decisions.length)} />
              <Stat label="Held for a person" value={held} display={number(held)} />
            </>
          )}
          <Stat
            label="Credits spent"
            value={budget ? budget.credits.used : null}
            display={budget ? number(budget.credits.used) : undefined}
            of={budget ? (budget.credits.cap !== null ? `of ${number(budget.credits.cap)}` : "no cap recorded") : undefined}
            note={budget ? `Model spend ${budget.usd.text} · ${budget.usd.capText}` : finished ? "No budget snapshot recorded" : "Arrives with the run's budget event"}
          />
        </StatRow>

        <div className="run-body">
          <Card as="section" padding="none" className="run-transcript" aria-label="Transcript" data-reveal>
            <header className="run-transcript-head">
              <div className="run-status" aria-live="polite">
                <h2 className="ui-title ui-title-card">Transcript</h2>
                <span>
                  {number(events.length)} {events.length === 1 ? "event" : "events"}
                  {statusText ? ` · ${statusText}` : ""}
                  {bundleState?.running && " · the bundle is written when the run finishes"}
                </span>
              </div>
              {controls.speed.visible && (
                <SpeedControl
                  speed={speed}
                  onSpeed={(s) => setParam("speed", s === 1 ? null : String(s))}
                  onRestart={() => setReplayNonce((n) => n + 1)}
                />
              )}
            </header>
            {streamError && (
              <p className="run-error run-stream-error" role="alert">
                {streamError.includes("No timeline") || streamError.includes(TimelineMissingError.name)
                  ? `No timeline is published for ${runId}. Export it with pnpm notary export.`
                  : streamError}
              </p>
            )}
            <div className="run-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Transcript events">
              {count === 0 && !streamError && <p className="run-muted run-empty">{runId ? "Waiting for the first event…" : "Choose a run."}</p>}
              <div className="run-virtual" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index];
                  return (
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      className="run-virtual-item"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      {row ? (
                        <TranscriptRow
                          row={row}
                          expanded={expanded.has(row.key)}
                          onToggle={() => toggle(row)}
                          entering={row.seq !== null && now - (arrivals.current.get(row.seq) ?? -Infinity) < ENTER_MS}
                          details={expanded.has(row.key) ? <RowDetailsView details={rowDetails(row, { bundle, index, world: worldView })} /> : undefined}
                          certificateHref={row.certificateId ? `/app/certificates/${encodeURIComponent(row.certificateId)}?run=${encodeURIComponent(row.event?.runId ?? "")}` : undefined}
                          card={(() => {
                            const card = heldCard(row, {
                              mode,
                              sample: !!entry && entry.state === "finished" && entry.sample,
                              bundle,
                              world: worldView,
                              approvals: approvals.list,
                              approvalsError: approvals.error === TOKEN_REQUIRED ? "Paste the session token above to load the approval list." : approvals.error,
                            });
                            if (!card) return undefined;
                            return (
                              <HeldCardView
                                card={card}
                                onApprove={card.kind === "actionable" ? () => setDialog({ kind: "approve", item: card.pending }) : undefined}
                                onReject={card.kind === "actionable" ? () => setDialog({ kind: "reject", item: card.pending }) : undefined}
                              />
                            );
                          })()}
                        />
                      ) : (
                        <div className="run-row run-waiting">
                          <div className="run-row-head">
                            <StatusMark mark="spinner" tone="neutral" />
                            <span className="run-row-main">
                              <span className="run-row-title run-muted">Waiting for the next event…</span>
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {!follow.follow && (
              <button
                type="button"
                className="run-jump"
                onClick={() => {
                  setFollow(jumpToLatest());
                  if (count) virtualizer.scrollToIndex(count - 1, { align: "end" });
                }}
              >
                Jump to latest{follow.unseen ? ` (${follow.unseen} new)` : ""}
              </button>
            )}
          </Card>
          <CertificatesRail items={touched} runId={runId} streaming={streaming} world={worldView} worldError={world && world.runId === runId ? world.error : undefined} />
        </div>
      </PageBody>

      {dialog && (
        <ConfirmDialog
          source={source}
          kind={dialog.kind}
          item={dialog.item}
          token={token}
          onClose={() => setDialog(null)}
          onDecided={() => setApprovalsNonce((n) => n + 1)}
          onStale={() => setApprovalsNonce((n) => n + 1)}
        />
      )}
    </Page>
  );
}

/* ------------------------------------------------------------------------------ stage bar */

function StageBar({ steps, finished }: { steps: StageStep[]; finished: boolean }) {
  const current = steps.find((s) => s.current);
  return (
    <ol className="run-stages" aria-label={`Progress: ${current ? `at ${current.label}` : finished ? "finished" : "not started"}`}>
      {steps.map((s) => (
        <li key={s.stage} data-state={s.state} data-current={s.current || undefined} aria-current={s.current ? "step" : undefined}>
          <span className="run-stage-bar" aria-hidden="true" />
          <span className="run-stage-label">
            {s.label}
            <span className="run-stage-count">{s.count}</span>
          </span>
          {s.alerts.length > 0 && <span className="run-stage-alert">{s.alerts.join(", ")}</span>}
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------------------------- speed control */

function SpeedControl({ speed, onSpeed, onRestart }: { speed: Speed; onSpeed: (s: Speed) => void; onRestart: () => void }) {
  return (
    <div className="run-speed" role="group" aria-label="Replay speed (restarts the replay)">
      {REPLAY_SPEEDS.map((s) => (
        <button key={String(s)} type="button" aria-pressed={speed === s} onClick={() => onSpeed(s)}>
          {speedLabel(s)}
        </button>
      ))}
      <button type="button" onClick={onRestart}>
        Replay from start
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------------- start run */

function IntegrationLine({ name, label }: { name: "llm" | "crustdata" | "dodo"; label: string }) {
  const view = useIntegration(name);
  return (
    <li data-state={view.state}>
      <span>{label}</span> {view.status?.label ?? view.message}
    </li>
  );
}

function StartRun({
  onStarted,
  token,
  setToken,
}: {
  onStarted: (runId: string) => void;
  token: string | null;
  setToken: (t: string | null) => void;
}) {
  const { source } = useDataSource();
  const [choice, setChoice] = useState(START_CHOICES[0]!.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const tokenId = useId();
  const start = async () => {
    const c = START_CHOICES.find((x) => x.value === choice);
    if (!c) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await source.startRun(c.req);
      onStarted(res.runId);
    } catch (e) {
      // The server's own text, verbatim (e.g. every BLOCKED line of a 503).
      setError(e instanceof LocalApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="run-start">
      <div className="run-start-row">
        <label className="sr-only" htmlFor={`${tokenId}-kind`}>
          Run to start
        </label>
        <Select id={`${tokenId}-kind`} value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
          {START_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
        <Button onClick={start} disabled={busy}>
          {busy ? "Starting…" : "Start Run"}
        </Button>
      </div>
      {!token && (
        <form
          className="run-token"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("token");
            if (typeof value === "string" && value.trim()) setToken(value.trim());
          }}
        >
          <label htmlFor={tokenId}>Session token</label>
          <input
            id={tokenId}
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Printed by notary serve at startup…"
          />
          <Button type="submit" size="sm" variant="secondary">
            Save Token
          </Button>
        </form>
      )}
      <ul className="run-integrations" aria-label="Integrations reported by notary serve">
        <IntegrationLine name="llm" label="Models" />
        <IntegrationLine name="crustdata" label="Crustdata" />
        <IntegrationLine name="dodo" label="Dodo" />
      </ul>
      {error && (
        <p className="run-error run-start-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- certificates rail */

function CertificatesRail({
  items,
  runId,
  streaming,
  world,
  worldError,
}: {
  items: TouchedCertificate[];
  runId?: string;
  /** Still replaying or running: more certificates may arrive. */
  streaming: boolean;
  world: CertificateView | null;
  worldError?: string;
}) {
  return (
    <aside className="run-rail" aria-label="Certificates in this run">
      <h2 className="ui-title ui-title-card">Certificates</h2>
      {worldError && <p className="run-error">Certificates withheld: {worldError}</p>}
      {items.length === 0 ? (
        <p className="run-muted">{streaming ? "No certificate issued or revoked in this run so far." : "This run issued or revoked no certificate."}</p>
      ) : (
        <ul className="run-rail-list">
          {items.map((c) => {
            const cert = world?.certificates.find((x) => x.id === c.id);
            return (
              <li key={c.id}>
                <CertificateCard
                  compact
                  tool={cert?.tool ?? c.id}
                  claimId={c.claimId ?? c.id}
                  revoked={c.current === "revoked"}
                  href={`/app/certificates/${encodeURIComponent(c.id)}${runId ? `?run=${encodeURIComponent(runId)}` : ""}`}
                  footer={
                    <>
                      {c.inRun} in this run
                      {c.current && ` · ${c.current === "active" ? "active now" : "revoked now"}`}
                    </>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
