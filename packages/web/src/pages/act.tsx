// Act group: Queue (+ decision detail), Approval desk, Ask Notary.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Queue, RequestDetail } from "../Queue";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusPill,
} from "../components/ui";
import { RecordLinks } from "../components";
import { useData } from "../state/DataProvider";
import { recordPath, withRun } from "../state/data-mode";
import { label, number } from "../data";
import { readOptionalJSON } from "../optional-json";
import {
  ExplainFileSchema,
  type Citation,
  type ExplainAnswer,
} from "../../../core/src/schema";
import { RecordNotFound, useBundle } from "./shared";

export function QueuePage() {
  const bundle = useBundle();
  return (
    <>
      <PageHeader
        title="Queue"
        description="Every money action, with its policy, guards, effects and evidence."
      />
      <Queue key={bundle.runId} bundle={bundle} />
    </>
  );
}

export function DecisionDetailPage() {
  const { decisionId = "" } = useParams();
  const bundle = useBundle();
  const decision = bundle.decisions.find((d) => d.id === decisionId);
  if (!decision)
    return (
      <RecordNotFound
        kind="Decision"
        id={decisionId}
        listPath="/app/queue"
        find={(b) => b.decisions.some((d) => d.id === decisionId)}
      />
    );
  const request = bundle.queue.find((r) => r.id === decision.requestId);
  return (
    <>
      <PageHeader
        eyebrow={`Decision · ${label(decision.requestType)} · ${decision.customerId}`}
        title={decision.requestId}
        description={decision.action}
        actions={<StatusPill value={decision.status} />}
      />
      <Card className="detail-card">
        <RequestDetail
          request={request}
          decision={decision}
          bundle={bundle}
          id={decision.requestId}
        />
      </Card>
    </>
  );
}

/** Held decisions of the selected run, read-only. Approving happens only on a local `notary serve`. */
export function ApprovalsPage() {
  const bundle = useBundle();
  const held = bundle.decisions.filter((d) => d.status === "held");
  return (
    <>
      <PageHeader
        title="Approval desk"
        description="Money actions the agent held for a human, with the evidence it was missing."
      />
      {held.length ? (
        <Card className="table-card">
          <div className="table-card-head">
            <h2>Held in {bundle.runId}</h2>
            <span className="muted">{number(held.length)} held</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Action</th>
                  <th>Why held</th>
                  <th>Missing beliefs</th>
                </tr>
              </thead>
              <tbody>
                {held.map((d) => {
                  const request = bundle.queue.find(
                    (r) => r.id === d.requestId,
                  );
                  return (
                    <tr key={d.id}>
                      <td>
                        <Link
                          to={withRun(recordPath.decision(d.id), bundle.runId)}
                        >
                          {d.requestId}
                        </Link>
                        <div className="muted">
                          {label(d.requestType)}
                          {request?.amount !== undefined &&
                            ` · ${number(request.amount)} ${request.currency ?? ""} minor units`}
                        </div>
                      </td>
                      <td>{d.action}</td>
                      <td>{d.evidencePack?.reason ?? "No reason recorded"}</td>
                      <td>
                        <RecordLinks bundle={bundle} beliefs={d.missingBeliefs} />
                        {!d.missingBeliefs.length && "None recorded"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <EmptyState title={`Nothing held in ${bundle.runId}`}>
          {bundle.decisions.length
            ? "Every decision in this run was executed, escalated or denied."
            : "This run made no queue decisions."}
        </EmptyState>
      )}
      <p className="caption">
        This view is read-only. Approving or rejecting a held action is only
        possible against a local <code>notary serve</code> in Dodo test mode.
      </p>
    </>
  );
}

function citationPath(c: Citation, fallbackRun: string): string | undefined {
  const run = c.runId ?? fallbackRun;
  switch (c.kind) {
    case "decision":
      return withRun(recordPath.decision(c.id), run);
    case "probe":
      return withRun(recordPath.probe(c.id), run);
    case "belief":
      return withRun(recordPath.belief(c.id), run);
    case "certificate":
      return withRun(recordPath.certificate(c.id), run);
    default:
      return undefined;
  }
}

/** Precomputed, deterministic answers from public/content/explain.json for the selected data world. */
export function AskPage() {
  const bundle = useBundle();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; answers: ExplainAnswer[] }
    | { status: "missing" }
    | { status: "error"; error: string }
  >({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    readOptionalJSON("content/explain.json", controller.signal)
      .then((raw) => {
        if (controller.signal.aborted) return;
        if (raw === undefined) return setState({ status: "missing" });
        const parsed = ExplainFileSchema.safeParse(raw);
        setState(
          parsed.success
            ? { status: "ready", answers: parsed.data.answers }
            : {
                status: "error",
                error:
                  "explain.json does not match the shared schema. Answers withheld.",
              },
        );
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted)
          setState({ status: "error", error: e.message });
      });
    return () => controller.abort();
  }, []);
  // Same data world only: fixture answers with fixture runs, real with real.
  const answers =
    state.status === "ready"
      ? state.answers
          .filter((a) => a.sample === bundle.sample)
          .sort(
            (a, b) =>
              Number(b.runIds.includes(bundle.runId)) -
              Number(a.runIds.includes(bundle.runId)),
          )
      : [];
  return (
    <>
      <PageHeader
        title="Ask Notary"
        description="Answers built only from recorded records, each sentence backed by a citation."
      />
      {state.status === "loading" ? (
        <LoadingState title="Loading answers…">
          Reading the published explain file.
        </LoadingState>
      ) : state.status === "error" ? (
        <ErrorState title="Answers withheld">{state.error}</ErrorState>
      ) : state.status === "missing" || !answers.length ? (
        <EmptyState title="No published answers for this data world">
          Answers are generated from records by{" "}
          <code>pnpm notary export --explain</code>; none are published for{" "}
          {bundle.sample ? "fixture" : "recorded"} runs.
        </EmptyState>
      ) : (
        <div className="answer-list">
          {answers.map((a) => (
            <Card className="answer-card" key={a.id}>
              <span className="eyebrow">
                {label(a.kind)} · {a.runIds.join(", ")}
              </span>
              <h2>{a.question}</h2>
              <p>{a.answer}</p>
              <div className="record-links">
                {a.citations.map((c, i) => {
                  const to = citationPath(c, bundle.runId);
                  return to ? (
                    <Link
                      className="record-chip"
                      key={`${c.kind}-${c.id}-${i}`}
                      to={to}
                    >
                      <span>{label(c.kind)}</span>
                      {c.id}
                    </Link>
                  ) : (
                    <code
                      className="record-chip muted"
                      key={`${c.kind}-${c.id}-${i}`}
                    >
                      <span>{label(c.kind)}</span>
                      {c.id}
                    </code>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
