// Replay chat routing: which recorded records a question is about, by keywords and ids only.
// Deterministic and pure (tested in test/chat-replay.test.ts). The replay engine (chat-replay.ts)
// turns each intent into steps that mirror the live chat tools.
import type { ChatCitation, Tool } from "../../../core/src/schema";

export type LookupTool = "crustdata_lookup" | "dodo_lookup";

export type Intent =
  | { kind: "why_held"; requestId?: string; runId?: string }
  | { kind: "certificate"; certId?: string; claimId?: string; tool?: Tool }
  | { kind: "revocations" }
  | { kind: "run_diff" }
  | { kind: "adversary" }
  | { kind: "approvals"; approvalId?: string; requestId?: string }
  | { kind: "runs"; runId?: string }
  | { kind: "health" }
  | { kind: "lookup"; tool: LookupTool; subject: string }
  | { kind: "doc"; url?: string }
  /** A pronoun ("it", "that one") resolved against the previous turn's first cited record. */
  | { kind: "followup"; citation: ChatCitation };

export type RouteContext = {
  /** Run ids of the conversation's world. */
  runIds: readonly string[];
  /** Claim ids known in the conversation's world (certificates and no-certificate records). */
  claimIds: readonly string[];
  /** Citations of the previous assistant turn (newest turn), for follow-ups. */
  previous?: readonly ChatCitation[];
};

export type Route = {
  intents: Intent[];
  /** What matched, in words, for the engine's opening note. */
  matched: string[];
};

const MAX_INTENTS = 3;
const PRONOUN = /\b(it|its|that|this|that one|this one|those|them|they|the same)\b/;
const LOOKUP_VERB = /\b(look\s*up|lookup|enrich|find|fetch|search|get)\b/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text: string, term: string) => new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(term)}($|[^A-Za-z0-9_-])`, "i").test(text);

/** "Look up Acme Corp in Crustdata" → "Acme Corp". */
export function lookupSubject(question: string, toolWord: RegExp): string {
  const q = question.trim().replace(/[?.!]+$/, "");
  const inTool = new RegExp(`\\b(?:look\\s*up|lookup|enrich|find|fetch|search(?:\\s+for)?|get)\\s+(.+?)\\s+(?:in|on|from|with|via)\\s+${toolWord.source}`, "i").exec(q);
  if (inTool?.[1]) return inTool[1].trim();
  const after = new RegExp(`${toolWord.source}\\s+(?:for|about|on)\\s+(.+)$`, "i").exec(q);
  if (after?.[1]) return after[1].trim();
  const verb = /\b(?:look\s*up|lookup|enrich|find|fetch)\s+(.+)$/i.exec(q);
  return verb?.[1]?.replace(new RegExp(`\\s*${toolWord.source}.*$`, "i"), "").trim() || "the requested record";
}

/** Route one question. Ids are removed before keyword matching (run ids contain words like "change"). */
export function routeQuestion(question: string, ctx: RouteContext): Route {
  const raw = question.trim();
  let q = raw.toLowerCase();
  const intents: Intent[] = [];
  const matched: string[] = [];
  const add = (intent: Intent, why: string) => {
    if (intents.length >= MAX_INTENTS) return;
    if (intents.some((i) => JSON.stringify(i) === JSON.stringify(intent))) return;
    intents.push(intent);
    matched.push(why);
  };

  // ---- ids
  const url = /https?:\/\/[^\s)>\]]+/i.exec(raw)?.[0];
  if (url) q = q.replace(url.toLowerCase(), " ");
  const certId = /\bcert-[0-9a-f]{16}\b/.exec(q)?.[0];
  const approvalId = /\bappr-[0-9a-f]{16}\b/.exec(q)?.[0];
  const runId = [...ctx.runIds].sort((a, b) => b.length - a.length).find((id) => has(q, id.toLowerCase()));
  if (runId) q = q.replaceAll(runId.toLowerCase(), " ");
  if (certId) q = q.replace(certId, " ");
  if (approvalId) q = q.replace(approvalId, " ");
  // Claim ids, full ("dodo.refund.amount-minor-units") or without the tool ("refund.amount-minor-units").
  let claimId: string | undefined;
  for (const id of [...ctx.claimIds].sort((a, b) => b.length - a.length)) {
    const short = id.slice(id.indexOf(".") + 1);
    if (has(q, id.toLowerCase())) {
      claimId = id;
      q = q.replace(id.toLowerCase(), " ");
      break;
    }
    if (short !== id && /[.-]/.test(short) && has(q, short.toLowerCase())) {
      claimId = id;
      q = q.replace(short.toLowerCase(), " ");
      break;
    }
  }
  const requestId = /\bq\d{2,}\b/.exec(q)?.[0];
  const tool: Tool | undefined = /\bcrustdata\b/.test(q) ? "crustdata" : /\bdodo\b/.test(q) ? "dodo" : undefined;
  const explicit = Boolean(url || certId || approvalId || runId || claimId || requestId);

  // ---- live-only tools first (they show as unavailable in replay)
  if (/\bcrustdata\b/.test(q) && LOOKUP_VERB.test(q) && !/\bcertif|\bclaim/.test(q))
    add({ kind: "lookup", tool: "crustdata_lookup", subject: lookupSubject(raw, /crustdata/) }, "a Crustdata lookup");
  if (/\bdodo\b/.test(q) && (LOOKUP_VERB.test(q) || /\b(pay|cus|ref|sub)_[a-z0-9]+/.test(q)) && !/\bcertif|\bclaim|\bheld\b|\brefunds? held/.test(q))
    add({ kind: "lookup", tool: "dodo_lookup", subject: lookupSubject(raw, /dodo(?:\s+payments)?/) }, "a Dodo Payments lookup");
  if (url || /\b(open|fetch|read)\b.*\b(docs?|documentation)\b/.test(q)) add({ kind: "doc", url }, "a docs page");
  if (/\b(health|integrations?|connected|connections?|api keys?|credentials|configured)\b/.test(q)) add({ kind: "health" }, "integration status");

  // ---- follow-ups: a pronoun and no explicit id → the previous turn's first cited record
  const previous = ctx.previous?.find((c) => c.type !== "api_response" && c.type !== "doc");
  if (!explicit && previous && PRONOUN.test(q)) add({ kind: "followup", citation: previous }, `“${PRONOUN.exec(q)![0]}” (the ${previous.type.replace("_", " ")} ${previous.id} from the last answer)`);

  // ---- recorded records
  if (/\brevok|\brevocation|\bunlearn/.test(q)) add({ kind: "revocations" }, "revocations");
  if (/\badversar|\bchalleng|\bdowngrad|\bnarrow/.test(q) || (/\breject/.test(q) && !/\bapprov/.test(q)))
    add({ kind: "adversary" }, "the adversary's verdicts");
  if (/\bchanged\b|\bwhat changes\b|\bdiff\b|\bdifference|\bcompare|\bcomparison|\bnaive\b.*\bguarded\b|\bguarded\b.*\bnaive\b/.test(q))
    add({ kind: "run_diff" }, "a naive vs guarded comparison");
  if (approvalId || /\bapprov|\bpending\b|\bwaiting\b/.test(q))
    add({ kind: "approvals", approvalId, requestId }, approvalId ? `approval ${approvalId}` : "held actions waiting for a human");
  if (requestId || /\bheld\b|\bhold\b|\bholds\b/.test(q))
    add({ kind: "why_held", requestId, runId }, requestId ? `request ${requestId}` : "held decisions");
  if (certId || claimId || /\bcertif|\bclaims?\b|\bknow about\b|\bknown about\b|\bwhat do (we|you) know\b|\bwhat does notary know\b/.test(q) || (tool && !intents.some((i) => i.kind === "lookup")))
    add({ kind: "certificate", certId, claimId, tool }, certId ? `certificate ${certId}` : claimId ? `claim ${claimId}` : tool ? `${tool} certificates` : "certificates");
  if (runId && !intents.some((i) => i.kind === "why_held" || i.kind === "run_diff")) add({ kind: "runs", runId }, `run ${runId}`);
  if (!intents.length && /\bruns?\b|\blast run\b|\blatest run\b|\bwhat happened\b/.test(q)) add({ kind: "runs" }, "the recorded runs");
  // A lookup always comes with what the records say about that tool.
  const lookup = intents.find((i): i is Extract<Intent, { kind: "lookup" }> => i.kind === "lookup");
  if (lookup && !intents.some((i) => i.kind === "certificate"))
    add({ kind: "certificate", tool: lookup.tool === "crustdata_lookup" ? "crustdata" : "dodo" }, "what the certificates say");
  return { intents, matched };
}
