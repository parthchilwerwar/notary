// Approval desk logic, kept pure (no React, no fetch) so every rule is unit-tested:
// which mode the desk is in, when Approve / Reject are offered, the typed-amount check, request
// building, and how server records, local run bundles and the selected run merge into one desk.
// The server enforces all of this again (packages/core/src/api/approvals.ts); the UI never relies
// on itself alone.
import {
  ApprovalRecordSchema,
  ApprovalRequestSchema,
  ApprovalsListSchema,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApprovalsList,
  type Decision,
  type PendingApproval,
  type RunBundle,
} from "../../../../core/src/schema";
import type { DataSource } from "../../data";

/**
 * local  = a local `notary serve` answered (/api/bundles): GET/POST /api/approvals exist.
 * hosted = static files only: read-only history, no actions at all.
 */
export type DeskMode = "local" | "hosted";

export const deskMode = (source: DataSource): DeskMode =>
  source === "api" ? "local" : "hosted";

export const HOSTED_NOTE =
  "Read-only. Approving or rejecting a held action happens only against a local `notary serve` in Dodo test mode.";

/** Minor units as digits, exactly what the human must type. */
export const amountDigits = (amount: number) => String(amount);

/**
 * The typed confirmation must equal the held amount exactly: same digits, no grouping, no
 * decimals, no unit. Surrounding whitespace is ignored. An unknown held amount never matches.
 */
export function amountMatches(typed: string, held: number | undefined): boolean {
  if (held === undefined || !Number.isSafeInteger(held)) return false;
  return typed.trim() === amountDigits(held);
}

export const reasonValid = (reason: string) => reason.trim().length > 0;

export type Gate = { allowed: true } | { allowed: false; reason: string };

const deny = (reason: string): Gate => ({ allowed: false, reason });

export type GateContext = {
  mode: DeskMode;
  /** From GET /api/approvals; undefined until loaded. */
  testMode?: boolean;
  token: string | null;
  /** The run bundle the item belongs to, when loaded (for the sample check and evidence). */
  bundle?: Pick<RunBundle, "sample">;
};

/** Reject: local mode, a token, a real (non-sample) loaded run. Allowed outside test mode (no money moves). */
export function rejectGate(ctx: GateContext): Gate {
  if (ctx.mode !== "local") return deny(HOSTED_NOTE);
  if (!ctx.bundle)
    return deny("This run's bundle is not loaded, so its evidence can't be shown. No decision is offered.");
  if (ctx.bundle.sample) return deny("Fixture data is never approvable.");
  if (!ctx.token) return deny("Paste the session token from `notary serve` first.");
  return { allowed: true };
}

/** Approve: everything Reject needs, plus Dodo test mode and a held amount the server could compute. */
export function approveGate(
  ctx: GateContext,
  item: Pick<PendingApproval, "amount">,
): Gate {
  const base = rejectGate(ctx);
  if (!base.allowed) return base;
  if (ctx.testMode !== true)
    return deny(
      "Dodo test mode is off on this `notary serve`. Approvals execute only in test mode.",
    );
  if (item.amount === undefined)
    return deny(
      "The held amount can't be told from the records (no seed manifest entry), so there is nothing to confirm against.",
    );
  return { allowed: true };
}

export type BuildResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string };

export function buildApproveRequest(
  item: Pick<PendingApproval, "runId" | "decisionId" | "amount">,
  typed: string,
): BuildResult {
  if (!amountMatches(typed, item.amount))
    return {
      ok: false,
      error:
        item.amount === undefined
          ? "The held amount is unknown; nothing to confirm against."
          : "The typed amount does not equal the held amount.",
    };
  const parsed = ApprovalRequestSchema.safeParse({
    decision: "approved",
    runId: item.runId,
    decisionId: item.decisionId,
    confirmedAmount: Number(typed.trim()),
  });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, error: "The approval request is not valid." };
}

export function buildRejectRequest(
  item: Pick<PendingApproval, "runId" | "decisionId">,
  reason: string,
): BuildResult {
  if (!reasonValid(reason))
    return { ok: false, error: "A rejection needs a reason." };
  const parsed = ApprovalRequestSchema.safeParse({
    decision: "rejected",
    runId: item.runId,
    decisionId: item.decisionId,
    reason: reason.trim(),
  });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, error: "The rejection request is not valid." };
}

/** GET /api/approvals body, validated with the shared schema. Throws on anything else. */
export function parseApprovalsList(raw: unknown): ApprovalsList {
  const parsed = ApprovalsListSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "The local API returned an approvals list that does not match the shared schema. Data withheld.",
    );
  return parsed.data;
}

/** POST /api/approvals success body, validated with the shared schema. Throws on anything else. */
export function parseApprovalRecord(raw: unknown): ApprovalRecord {
  const parsed = ApprovalRecordSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "The local API answered with an approval record that does not match the shared schema. Treat the outcome as unknown and reload the list.",
    );
  return parsed.data;
}

export const itemKey = (runId: string, decisionId: string) =>
  `${runId}\n${decisionId}`;

export type PendingRow = {
  key: string;
  item: PendingApproval;
  bundle?: RunBundle;
  decision?: Decision;
};

export type DecidedRow = {
  key: string;
  record: ApprovalRecord;
  bundle?: RunBundle;
  decision?: Decision;
};

export type HistoryRow = {
  key: string;
  bundle: RunBundle;
  decision: Decision;
  /** Why this held item has no actions here. */
  note: string;
};

export type Desk = {
  mode: DeskMode;
  pending: PendingRow[];
  decided: DecidedRow[];
  /** Held decisions of the selected run that the desk doesn't list as pending or decided. */
  history: HistoryRow[];
  /** Pending items dropped because their run is fixture data (never approvable). */
  droppedSample: number;
};

export const heldDecisions = (bundle: RunBundle) =>
  bundle.decisions.filter((d) => d.status === "held");

/**
 * One desk from the server list (local mode only), every loaded bundle and the selected run.
 * Hosted mode ignores any list: there are no pending items and no actions, only history.
 */
export function buildDesk({
  mode,
  list,
  bundles,
  selected,
}: {
  mode: DeskMode;
  list?: ApprovalsList;
  bundles: RunBundle[];
  selected?: RunBundle;
}): Desk {
  const byRun = new Map(bundles.map((b) => [b.runId, b]));
  const lookup = (runId: string, decisionId: string) => {
    const bundle = byRun.get(runId);
    return { bundle, decision: bundle?.decisions.find((d) => d.id === decisionId) };
  };
  const local = mode === "local" ? list : undefined;
  let droppedSample = 0;
  const pending: PendingRow[] = [];
  for (const item of local?.pending ?? []) {
    const found = lookup(item.runId, item.decisionId);
    if (found.bundle?.sample) {
      droppedSample += 1;
      continue;
    }
    pending.push({ key: itemKey(item.runId, item.decisionId), item, ...found });
  }
  const decided: DecidedRow[] = (local?.decided ?? [])
    .map((record) => ({
      key: itemKey(record.runId, record.decisionId),
      record,
      ...lookup(record.runId, record.decisionId),
    }))
    .sort((a, b) => b.record.decidedAt.localeCompare(a.record.decidedAt));
  const listed = new Set([...pending, ...decided].map((r) => r.key));
  const history: HistoryRow[] = selected
    ? heldDecisions(selected)
        .filter((d) => !listed.has(itemKey(selected.runId, d.id)))
        .map((decision) => ({
          key: itemKey(selected.runId, decision.id),
          bundle: selected,
          decision,
          note: historyNote(mode, selected),
        }))
    : [];
  return { mode, pending, decided, history, droppedSample };
}

function historyNote(mode: DeskMode, bundle: RunBundle): string {
  if (bundle.sample) return "Fixture data: recorded for review, never approvable.";
  if (mode === "hosted") return "Recorded history. Decide it on a local `notary serve`.";
  return "Not listed by the local server: only verified, live, guarded runs under runs/ with a write action are approvable.";
}

/** "1,000 USD minor units" style text; the currency is shown only when recorded. */
export function minorUnitsText(
  amount: number,
  currency: string | undefined,
  format: (n: number) => string,
): string {
  return `${format(amount)}${currency ? ` ${currency}` : ""} minor units`;
}
