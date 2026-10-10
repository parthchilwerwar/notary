// Approval desk (/app/approvals).
// Local mode (a `notary serve` answered): pending items from GET /api/approvals with Approve (typed
// amount) and Reject (reason), decided records, and the selected run's other held items as history.
// Hosted mode: read-only history of the selected run's held items; no actions at all.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRecord, ApprovalsList } from "../../../../core/src/schema";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusPill,
} from "../../components/ui";
import { useData } from "../../state/DataProvider";
import { LocalApiError, number, useSessionToken } from "../../data";
import { useBundle } from "../shared";
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
import { DecidedItem, HistoryItem, PendingItem, TokenForm } from "./parts";
import "./approvals.css";

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: ApprovalsList }
  | { status: "error"; error: string };

export function ApprovalsPage() {
  const { source, bundles, dataSource } = useData();
  const selected = useBundle();
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
    () => buildDesk({ mode, list: data, bundles, selected }),
    [mode, data, bundles, selected],
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
  const heldInSelected = heldDecisions(selected).length;

  return (
    <>
      <PageHeader
        title="Approval desk"
        description="Money actions the agent held for a human, with the evidence it was missing and the trail that led there."
        actions={
          mode === "local" ? (
            <>
              <StatusPill tone="info">Local notary serve</StatusPill>
              {data && (
                <StatusPill tone={data.testMode ? "safe" : "unsafe"}>
                  {data.testMode ? "Dodo test mode on" : "Dodo test mode off"}
                </StatusPill>
              )}
            </>
          ) : (
            <StatusPill tone="neutral">Read-only</StatusPill>
          )
        }
      />

      {mode === "hosted" ? (
        <p className="desk-note" role="note">
          Read-only history. Approving or rejecting a held action happens only against a local{" "}
          <code>notary serve</code> in Dodo test mode.
        </p>
      ) : (
        <section className="desk-local" aria-label="Local approvals">
          <TokenForm token={token} setToken={setToken} error={tokenError} />
          {data && !data.testMode && (
            <p className="desk-gate" role="note">
              Approvals are disabled: this <code>notary serve</code> is not in Dodo test mode, and
              approvals execute only in test mode. Rejecting needs no external call and stays
              available.
            </p>
          )}

          {list.status === "loading" && (
            <LoadingState title="Loading held actions…">
              Asking the local <code>notary serve</code> for pending and decided approvals.
            </LoadingState>
          )}
          {list.status === "error" && (
            <ErrorState
              title="Approvals unavailable"
              actions={
                <Button variant="outline" onClick={refresh}>
                  Try again
                </Button>
              }
            >
              {list.error}
            </ErrorState>
          )}

          {latestRow && (
            <div className="desk-section" aria-live="polite">
              <h2>Latest decision</h2>
              <DecidedItem row={latestRow} highlight />
            </div>
          )}

          {data && (
            <div className="desk-section">
              <div className="desk-section-head">
                <h2>Awaiting a human</h2>
                <span className="muted">
                  {number(desk.pending.length)} pending across local runs
                </span>
              </div>
              {desk.pending.length ? (
                desk.pending.map((row, i) => {
                  const ctx = {
                    mode,
                    testMode: data.testMode,
                    token,
                    bundle: row.bundle,
                  };
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
                })
              ) : (
                <EmptyState title="Nothing is waiting for a human">
                  The local server lists held write actions only from verified, live, guarded runs
                  under <code>runs/</code>. None are held right now
                  {data.decided.length ? ", and every listed item has been decided" : ""}.
                  {desk.droppedSample > 0 &&
                    ` ${number(desk.droppedSample)} item(s) from fixture runs were not offered.`}
                </EmptyState>
              )}
            </div>
          )}

          {data && desk.decided.length > 0 && (
            <div className="desk-section">
              <div className="desk-section-head">
                <h2>Decided</h2>
                <span className="muted">{number(desk.decided.length)} recorded</span>
              </div>
              {desk.decided
                .filter((row) => row.record.id !== latest?.id)
                .map((row) => (
                  <DecidedItem key={row.record.id} row={row} />
                ))}
            </div>
          )}
        </section>
      )}

      <div className="desk-section">
        <div className="desk-section-head">
          <h2>Held in {selected.runId}</h2>
          <span className="muted">
            {number(heldInSelected)} held
            {desk.history.length !== heldInSelected &&
              ` · ${number(desk.history.length)} not listed above`}
          </span>
        </div>
        {desk.history.length ? (
          desk.history.map((row, i) => (
            <HistoryItem key={row.key} row={row} openTrail={i === 0} />
          ))
        ) : (
          <EmptyState title={`Nothing else held in ${selected.runId}`}>
            {heldInSelected
              ? "Every held action of this run is listed above."
              : selected.decisions.length
                ? "Every decision in this run was executed, escalated or denied."
                : "This run made no queue decisions."}
          </EmptyState>
        )}
      </div>

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
          }}
          onStale={refresh}
        />
      )}
    </>
  );
}
