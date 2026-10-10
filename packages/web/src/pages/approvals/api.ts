// Approval desk calls, through the data layer: DataSource.approvals() (GET /api/approvals, token
// required) and approve/reject (POST /api/approvals/:id/approve|reject). LiveSource validates both
// bodies with the shared schemas; ReplaySource throws ReplayOnlyError (the hosted desk is read-only).
import type {
  ApprovalRecord,
  ApprovalRequest,
  ApprovalsList,
  PendingApproval,
} from "../../../../core/src/schema";
import { approvalId, type DataSource } from "../../data";

export function fetchApprovals(source: DataSource, signal?: AbortSignal): Promise<ApprovalsList> {
  return source.approvals(signal);
}

/** The id the server routes by: the pending item's own, else derived exactly as the server does. */
export const pendingId = (item: Pick<PendingApproval, "id" | "runId" | "decisionId">) =>
  item.id ?? approvalId(item.runId, item.decisionId);

/** Throws LocalApiError with the server's `{error}` text (400/401/403/404/409/503) on refusal. */
export function submitDecision(
  source: DataSource,
  item: Pick<PendingApproval, "id" | "runId" | "decisionId">,
  request: ApprovalRequest,
): Promise<ApprovalRecord> {
  const id = pendingId(item);
  return request.decision === "approved"
    ? source.approve(id, request.confirmedAmount)
    : source.reject(id, request.reason);
}
