// Approvals (/app/approvals).
// Live mode (a `notary serve` answered): pending items from GET /api/approvals with Approve (typed
// amount) and Reject (reason), decided records, and the selected run's other held items as history.
// Replay: read-only. Held decisions of every recorded run (DataSource.approvals(), the same list the
// sidebar counts), grouped by cohort, plus the selected run's held items; no actions at all.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRecord, ApprovalsList, RunBundle } from "../../../../core/src/schema";
import { Link } from "react-router";
import { Button, EmptyState, Note, Page, PageBody, PageHeader, Section, Skeleton, Stat, StatRow, usePageMotion } from "../../ui";
import { useData } from "../../app/catalog";
import { LocalApiError, number, useHostedBuild, useSessionToken } from "../../data";
import { withRun } from "../../app/links";
import { useOptionalShellStatus } from "../../components/shell/status";
import { RecordedHolds } from "./RecordedHolds";
import { fetchApprovals } from "./api";
import { ConfirmDialog, type DialogKind } from "./ConfirmDialog";
import {
  approveGate,
  buildDesk,
  deskMode,
  heldDecisions,
  itemKey,
  rejectGate,
  type PendingRow,
} from "./model";
import { DecidedItem, HistoryItem, NoteText, PendingItem, TokenForm } from "./parts";
import "./approvals.css";

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: ApprovalsList }
  | { status: "error"; error: string };

export function ApprovalsPage() {
  const { source, bundles, dataSource, bundle, running = [], selectedRunId } = useData();
  const hosted = useHostedBuild();
  const shellStatus = useOptionalShellStatus();
  // A live run that is still running has no bundle yet (the gate lets it through): no history for it.
  const selected: RunBundle | undefined = bundle;
  const visible = useMemo(() => new Set([...bundles.map((b) => b.runId), ...running.map((r) => r.runId)]), [bundles, running]);
  const mode = deskMode(source);
  const [token, setToken] = useSessionToken();
  const [list, setList] = useState<ListState>({ status: "idle" });
  const [tokenError, setTokenError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<{ kind: DialogKind; row: PendingRow }>();
  const [latest, setLatest] = useState<ApprovalRecord>();
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (mode !== "local" || !token) {
      setList({ status: "idle" });
      return;
    }
    let live = true;
    setList((s) => (s.status === "ready" ? s : { status: "loading" }));
    fetchApprovals(dataSource)
      .then((data) => {
        if (!live) return;
        setTokenError(undefined);
        setList({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!live) return;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof LocalApiError && err.status === 401) {
          setTokenError(message);
          setToken(null);
          return;
        }
        setList({ status: "error", error: message });
      });
    return () => {
      live = false;
    };
  }, [mode, token, reloadKey, setToken, dataSource]);

  const data = list.status === "ready" ? list.data : undefined;
  const desk = useMemo(
    () => buildDesk({ mode, list: data, bundles, selected, visible }),
    [mode, data, bundles, selected, visible],
  );
  const latestRow = latest
    ? desk.decided.find((r) => r.record.id === latest.id) ?? {
        key: itemKey(latest.runId, latest.decisionId),
        record: latest,
        bundle: bundles.find((b) => b.runId === latest.runId),
        decision: bundles
          .find((b) => b.runId === latest.runId)
          ?.decisions.find((d) => d.id === latest.decisionId),
      }
    : undefined;
  const heldInSelected = selected ? heldDecisions(selected).length : 0;
  const runName = selected?.runId ?? selectedRunId ?? "the selected run";
  // Every history row of one run usually carries the same note: say it once above the rows.
  const sharedNote =
    desk.history.length > 1 && desk.history.every((r) => r.note === desk.history[0]!.note) ? desk.history[0]!.note : undefined;

  const root = usePageMotion([runName, list.status, desk.pending.length]);
  const summary =
    mode === "local"
      ? data
        ? `${number(desk.pending.length)} waiting for review · Dodo test mode ${data.testMode ? "on" : "off"}`
        : "Paste the session token to see what is waiting"
      : selected
        ? `${number(heldInSelected)} held in ${selected.runId} · read-only history`
        : `${runName} is still running · read-only history`;

  return (
    <Page ref={root}>
      <PageHeader
        title="Approvals"
        summary={summary}
        action={
          <Button asChild>
            <Link to={withRun("/app/run", runName === "the selected run" ? undefined : runName)}>Open the run</Link>
          </Button>
        }
      />
      <PageBody>
        {mode === "local" && data && (
          <StatRow label="Approvals">
            <Stat label="Waiting for review" value={desk.pending.length} />
            <Stat label="Decided by a human" value={desk.decided.length} />
            <Stat label={`Held in ${runName}`} value={selected ? heldInSelected : null} />
          </StatRow>
        )}

        {mode === "hosted" ? (
          <>
            <Note className="desk-note">
              {hosted ? (
                <>
                  Read-only history. This hosted build always replays and never connects to a local server: approving or
                  rejecting a held action happens only against a local <code>notary serve</code> in Dodo test mode. To decide
                  held actions, clone the repository, run <code>pnpm notary serve</code>, then{" "}
                  <code>pnpm --filter @notary/web dev</code> and open the local page.
                </>
              ) : (
                <>
                  Read-only history. Approving or rejecting a held action happens only against a local{" "}
                  <code>notary serve</code> in Dodo test mode. Start the server to approve live.
                </>
              )}
            </Note>
            <RecordedHolds />
          </>
        ) : (
          <section className="desk-local" aria-label="Local approvals">
            <TokenForm token={token} setToken={setToken} error={tokenError} />
            {data && !data.testMode && (
              <Note tone="warning">
                Approvals are disabled: this <code>notary serve</code> is not in Dodo test mode, and approvals execute only
                in test mode. Rejecting needs no external call and stays available.
              </Note>
            )}

            {list.status === "loading" && (
              <div className="desk-loading" role="status" aria-live="polite">
                <span className="sr-only">Loading held actions…</span>
                <Skeleton shape="card" />
              </div>
            )}
            {list.status === "error" && (
              <EmptyState
                tone="error"
                title="Approvals unavailable"
                action={
                  <Button variant="secondary" onClick={refresh}>
                    Try again
                  </Button>
                }
              >
                <p>
                  The local server did not return its approval list. Check that <code>pnpm notary serve</code> is running,
                  then try again.
                </p>
                <p className="desk-muted">{list.error}</p>
              </EmptyState>
            )}

            {latestRow && (
              <Section title="Latest decision" aria-live="polite">
                <div className="desk-rows">
                  <DecidedItem row={latestRow} highlight />
                </div>
              </Section>
            )}

            {data && (
              <Section title="Awaiting a human" description={`${number(desk.pending.length)} pending across local runs`}>
                {desk.pending.length ? (
                  <div className="desk-rows">
                    {desk.pending.map((row, i) => {
                      const ctx = { mode, testMode: data.testMode, token, bundle: row.bundle };
                      return (
                        <PendingItem
                          key={row.key}
                          row={row}
                          approve={approveGate(ctx, row.item)}
                          reject={rejectGate(ctx)}
                          onApprove={() => setDialog({ kind: "approve", row })}
                          onReject={() => setDialog({ kind: "reject", row })}
                          openTrail={i === 0}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState title="Nothing waiting for review.">
                    The local server lists held write actions only from verified, live, guarded runs under{" "}
                    <code>runs/</code>. None are held right now
                    {data.decided.length ? ", and every listed item has been decided" : ""}.
                    {desk.droppedHidden > 0 &&
                      ` ${number(desk.droppedHidden)} ${desk.droppedHidden === 1 ? "item belongs" : "items belong"} to runs this view does not show.`}
                    {desk.droppedSample > 0 &&
                      ` ${number(desk.droppedSample)} ${desk.droppedSample === 1 ? "item" : "items"} from recorded, non-live runs ${desk.droppedSample === 1 ? "was" : "were"} not offered.`}
                  </EmptyState>
                )}
              </Section>
            )}

            {data && desk.decided.length > 0 && (
              <Section title="Decided" description={`${number(desk.decided.length)} recorded`}>
                <div className="desk-rows">
                  {desk.decided
                    .filter((row) => row.record.id !== latest?.id)
                    .map((row) => (
                      <DecidedItem key={row.record.id} row={row} />
                    ))}
                </div>
              </Section>
            )}
          </section>
        )}

        {selected ? (
        <Section
          title={`Held in ${selected.runId}`}
          description={
            desk.history.length !== heldInSelected
              ? `${number(heldInSelected)} held · ${number(desk.history.length)} not listed above`
              : undefined
          }
        >
          {desk.history.length ? (
            <>
              {sharedNote && (
                <Note className="desk-shared-note">
                  <NoteText text={sharedNote} />
                </Note>
              )}
              <div className="desk-rows">
                {desk.history.map((row, i) => (
                  <HistoryItem key={row.key} row={row} openTrail={i === 0 && mode === "local"} showNote={!sharedNote} />
                ))}
              </div>
            </>
          ) : (
            <EmptyState title={heldInSelected ? "Nothing else held" : "Nothing waiting for review."}>
              {heldInSelected
                ? "Every held action of this run is listed above."
                : selected.decisions.length
                  ? "Every decision in this run was executed, escalated or denied."
                  : "This run made no queue decisions."}
            </EmptyState>
          )}
        </Section>
        ) : (
          <Section title={`Held in ${runName}`}>
            <EmptyState title="This run is still running">
              Its held actions are listed once it finishes and its bundle is written and verified.
            </EmptyState>
          </Section>
        )}
      </PageBody>

      {dialog && (
        <ConfirmDialog
          key={`${dialog.kind}:${dialog.row.key}`}
          source={dataSource}
          kind={dialog.kind}
          item={dialog.row.item}
          token={token}
          onClose={() => setDialog(undefined)}
          onDecided={(record) => {
            setLatest(record);
            refresh();
            shellStatus?.refreshApprovals();
          }}
          onStale={refresh}
        />
      )}
    </Page>
  );
}
