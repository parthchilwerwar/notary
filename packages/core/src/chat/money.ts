// Deterministic detection of obvious money-moving / state-changing requests in a chat message
// ("refund pay_123", "approve the held refund", "change the plan for sub_9 to Pro", "credit the
// wallet"). The chat agent can never do any of these (no write tool exists, and every tool client is
// read-only by construction); detection only makes the turn say so reliably: the agent loop adds a
// real read step (list_approvals: what is actually held), tells the model, and makes sure the answer
// points to the Approvals card. Questions *about* such actions ("why was the refund held?", "what
// happens if I approve it?") are not requests and do not match.

/** Where a human approves or rejects held actions in the Notary app. */
export const APPROVALS_PATH = "/app/approvals";

/** The notice appended (by code) when the model's answer to a money-moving request does not point to the Approvals card. */
export const MONEY_NOTICE = `Notary Chat is read-only and cannot move money or change anything. Held actions are approved or rejected by a person on the Approvals card (${APPROVALS_PATH}), where each one shows its evidence and needs the exact amount typed to approve.`;

/** Request lead-ins: "please", "can you", "go ahead and", ... (repeatable). */
const LEAD = String.raw`(?:(?:hey|ok|okay|so|now|then|just|please|pls|kindly|can you|could you|would you|will you|go ahead and|i want you to|i need you to|i'd like you to|let'?s|you should|you must|make sure to|try to|and)[,!.]?\s+)*`;

/** Verbs that are a money/state action on their own. */
const STRONG = ["refund", "re-fund", "approve", "unhold", "chargeback", "reimburse"];
/** Verbs that need a money/state object nearby to count. */
const WEAK = ["reject", "deny", "execute", "issue", "process", "charge", "pay", "transfer", "send", "cancel", "change", "switch", "upgrade", "downgrade", "credit", "debit", "create", "apply", "release", "retry", "move", "void", "capture", "top up", "add"];
const OBJECT = /\b(refunds?|payments?|money|funds|amount|plan|subscriptions?|wallets?|credits?|ledger|charges?|approvals?|held|hold|action|invoice|balance|it|this|that|them)\b|\$\s?\d|\b\d+(\.\d+)?\s?(usd|inr|eur|gbp|dollars?|rupees?)\b|\b(pay|sub|ref|cus|appr)[_-][a-z0-9]/i;

export interface MoneyRequest {
  moneyMoving: boolean;
  /** The verb that matched (lowercased), when moneyMoving. */
  verb?: string;
}

/** True for an imperative request to move money or change state; false for questions about it. */
export function detectMoneyRequest(content: string): MoneyRequest {
  const text = content.toLowerCase().replace(/\s+/g, " ").trim();
  // Each sentence / clause is checked on its own ("Thanks. Now refund pay_1." matches).
  for (const clause of text.split(/(?<=[.!?;\n])\s+|\s+(?:and then|then)\s+/)) {
    const c = clause.trim();
    if (!c) continue;
    const m = new RegExp(String.raw`^${LEAD}(${[...STRONG, ...WEAK].map((v) => v.replace(/[-\s]/g, (x) => (x === " " ? "\\s+" : "\\-"))).join("|")})\b(.*)$`, "i").exec(c);
    if (!m) continue;
    const verb = m[1]!.replace(/\s+/g, " ");
    const rest = m[2] ?? "";
    // "refund policy", "approval process": a noun phrase, not an order.
    if (/^\s*(policy|policies|process|status|history|rules?|flow|logic|window)\b/.test(rest)) continue;
    if (STRONG.includes(verb) || OBJECT.test(rest)) return { moneyMoving: true, verb };
  }
  return { moneyMoving: false };
}
