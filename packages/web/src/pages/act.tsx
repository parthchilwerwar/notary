// Act group: Queue and decision detail. The Approval desk lives in ./approvals, Ask Notary in
// ../components/ask.
import { useParams } from "react-router";
import { Queue, RequestDetail, unsafeOf } from "../Queue";
import { Card, PageHeader, StatusPill } from "../components/ui";
import { label } from "../data";
import { RecordNotFound, useBundle } from "./shared";
import { DecisionTrail } from "../components/trail";

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
        actions={
          <>
            <StatusPill value={decision.status} />
            {unsafeOf(decision).length > 0 && (
              <StatusPill tone="unsafe">
                unsafe · {unsafeOf(decision).map(label).join(", ")}
              </StatusPill>
            )}
          </>
        }
      />
      <DecisionTrail bundle={bundle} decisionId={decision.id} />
      <div className="section-heading">
        <h2>Full record</h2>
        <p>The decision record as stored in the run bundle.</p>
      </div>
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
