// GET/POST /api/approvals through the shared local client (token header, verbatim server errors).
// Both bodies are validated with the shared schemas before anything is shown.
import type { ApprovalRecord, ApprovalRequest, ApprovalsList } from "../../../../core/src/schema";
import { localFetch } from "../../state/local-api";
import { parseApprovalRecord, parseApprovalsList } from "./model";

export async function fetchApprovals(token: string | null): Promise<ApprovalsList> {
  return parseApprovalsList(await localFetch("/api/approvals", {}, token));
}

/** Throws LocalApiError with the server's `{error}` text (400/403/404/409/503) on refusal. */
export async function submitDecision(
  request: ApprovalRequest,
  token: string | null,
): Promise<ApprovalRecord> {
  const body = await localFetch(
    "/api/approvals",
    { method: "POST", body: JSON.stringify(request) },
    token,
  );
  return parseApprovalRecord(body);
}
