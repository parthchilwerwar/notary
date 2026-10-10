/**
 * `notary export --content`: packages/web/public/content/glossary.json, the plain-language words
 * the dashboard shows next to claim ids and enum values. Generated FROM CODE so it cannot drift:
 *
 *   claims            one entry per claim in allContracts; name, explanation and example are built
 *                     from the claim itself (tool, operation, param, expect rule, first recon note)
 *   enum sections     one entry per value of the frozen schema enums (DefectClass, GuardKind,
 *                     BeliefStatus, DecisionStatus, ProbeVerdict, PolicyOutcome, ProbeTemplate),
 *                     enumerated from the zod `.options`; the human words live in ONE typed map per
 *                     enum (`Record<Enum, Words>`), so a new enum value is a compile error until it
 *                     has an entry (test/content.test.ts double-checks at runtime)
 *
 * Deterministic: no clock. The header carries a content hash instead of a timestamp, so rerunning
 * the export only changes the file when the content changed. test/content.test.ts fails if the
 * committed file differs from a fresh build (fix: rerun `pnpm notary export --content`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import { allContracts, type ContractEntry } from "../contracts/index.js";
import {
  BeliefStatusSchema,
  DecisionStatusSchema,
  DefectClassSchema,
  GuardKindSchema,
  PolicyOutcomeSchema,
  ProbeTemplateSchema,
  ProbeVerdictSchema,
  Sha256HexSchema,
  ToolSchema,
} from "../schema/index.js";
import type {
  BeliefStatus,
  DecisionStatus,
  DefectClass,
  ExpectRule,
  GuardKind,
  PolicyOutcome,
  ProbeTemplate,
  ProbeVerdict,
  Tool,
} from "../schema/index.js";

export const CONTENT_GENERATED_BY = "pnpm notary export --content";
export const GLOSSARY_FILE = "glossary.json";
export const DEFAULT_CONTENT_DIR = fileURLToPath(new URL("../../../web/public/content/", import.meta.url));
export const GLOSSARY_PATH = join(DEFAULT_CONTENT_DIR, GLOSSARY_FILE);

const GLOSSARY_NOTE =
  "Generated from code (contracts and schema enums in packages/core); do not edit by hand. " +
  "Rerun `pnpm notary export --content` after changing a claim or an enum.";

// ------------------------------------------------------------------------------------- schema

/** One plain sentence: non-empty, a single period at the very end, no line breaks. */
const OneSentence = z
  .string()
  .min(1)
  .refine((s) => /^[^\n.]+\.$/.test(s), { message: "explanation must be one sentence ending in its only period" });

export const GlossaryEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    explanation: OneSentence,
    example: z.string().min(1),
  })
  .strict();

export const ClaimGlossaryEntrySchema = GlossaryEntrySchema.extend({
  tool: ToolSchema,
  operation: z.string().min(1),
  /** The documented promise, quoted verbatim from the claim. */
  docText: z.string().min(1),
  docUrl: z.url(),
}).strict();

const SECTION_KEYS = [
  "claims",
  "defectClasses",
  "guardKinds",
  "beliefStatuses",
  "decisionStatuses",
  "probeVerdicts",
  "policyOutcomes",
  "probeTemplates",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

const count = z.number().int().nonnegative();

export const GlossarySchema = z
  .object({
    generatedBy: z.literal(CONTENT_GENERATED_BY),
    note: z.string().min(1),
    /** sha256 of canonicalJson(sections): changes exactly when the content does. */
    contentHash: Sha256HexSchema,
    counts: z.object(Object.fromEntries(SECTION_KEYS.map((k) => [k, count])) as Record<SectionKey, typeof count>).strict(),
    sections: z
      .object({
        claims: z.array(ClaimGlossaryEntrySchema),
        defectClasses: z.array(GlossaryEntrySchema),
        guardKinds: z.array(GlossaryEntrySchema),
        beliefStatuses: z.array(GlossaryEntrySchema),
        decisionStatuses: z.array(GlossaryEntrySchema),
        probeVerdicts: z.array(GlossaryEntrySchema),
        policyOutcomes: z.array(GlossaryEntrySchema),
        probeTemplates: z.array(GlossaryEntrySchema),
      })
      .strict(),
  })
  .strict()
  .refine((g) => SECTION_KEYS.every((k) => g.counts[k] === g.sections[k].length), { message: "counts must match section lengths" })
  .refine((g) => SECTION_KEYS.every((k) => new Set(g.sections[k].map((e) => e.id)).size === g.sections[k].length), {
    message: "ids must be unique within a section",
  })
  .refine((g) => g.contentHash === sha256Hex(canonicalJson(g.sections)), { message: "contentHash does not match sections" });

export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;
export type ClaimGlossaryEntry = z.infer<typeof ClaimGlossaryEntrySchema>;
export type Glossary = z.infer<typeof GlossarySchema>;

/** The hand-written part of an enum entry (the id comes from the enum). */
export interface Words {
  name: string;
  explanation: string;
  example: string;
}

// ------------------------------------------------------------------- hand-written enum words

export const DEFECT_CLASS_WORDS: Record<DefectClass, Words> = {
  silent_truncation: {
    name: "Silent truncation",
    explanation: "The tool quietly returns fewer items than you asked for, without saying anything was left out.",
    example: "You ask for 101 refunds per page and get exactly 100 back with no error, so one refund is silently missing.",
  },
  silent_coercion: {
    name: "Silent coercion",
    explanation: "The tool quietly changes a value or its type, such as sending a number as text or dropping a setting you sent.",
    example: "A headcount documented as a whole number arrives as the text \"1234\".",
  },
  unit_mismatch: {
    name: "Unit mismatch",
    explanation: "The tool reads or reports money in a different unit than its docs say, such as dollars instead of cents.",
    example: "You refund 1234 meaning $12.34, and the tool treats it as $1,234.",
  },
  undocumented_flag: {
    name: "Undocumented setting",
    explanation: "The tool reacts to a setting its docs never mention, or ignores the documented rules for one.",
    example: "Asking the identify endpoint for an enrich-only field group returns data instead of the documented 400 error.",
  },
  eventual_consistency: {
    name: "Delayed visibility",
    explanation: "A change you just made takes a while to show up when you read the data back.",
    example: "A refund created a moment ago is missing from the payment's refund list for a few seconds.",
  },
  idempotency_hazard: {
    name: "Duplicate on retry",
    explanation: "Sending the same request again, for example after a timeout, can make the action happen twice.",
    example: "Retrying a refund that timed out creates a second refund for the same payment.",
  },
  rate_limit: {
    name: "Rate limit",
    explanation: "The tool starts refusing requests when too many arrive in a short time.",
    example: "A quick burst of balance checks starts getting status 429 (too many requests).",
  },
  expiry: {
    name: "Expiry",
    explanation: "Something the tool gave you stops working after a while, such as a link, a token or a cached answer.",
    example: "A payment link that worked an hour ago now returns an error.",
  },
  mislabelled_semantics: {
    name: "Mislabelled meaning",
    explanation: "A field or status means something different from what its name or the docs suggest.",
    example: "A field named employee count range holds a single number instead of a range like 51-200.",
  },
  honored: {
    name: "Honored",
    explanation: "The tool behaves exactly as its docs say.",
    example: "Asking for 101 refunds per page is refused with an error, just as documented.",
  },
};

export const GUARD_KIND_WORDS: Record<GuardKind, Words> = {
  transform: {
    name: "Fix the value",
    explanation: "Before the call, Notary rewrites a value so the tool receives what it really expects.",
    example: "If the tool turns out to read refund amounts 100 times too large, Notary divides the amount by 100 before sending it.",
  },
  require_param: {
    name: "Always send the setting",
    explanation: "Notary always fills in a setting the tool needs with a known safe value instead of trusting the tool's default.",
    example: "Every company enrichment call is sent with the basic info, headcount and funding field groups listed.",
  },
  precheck: {
    name: "Check first",
    explanation: "Before a money action, Notary reads the current state and stops if the action would repeat or clash with something already there.",
    example: "Before refunding, Notary lists all of the customer's refunds and stops if one already exists for that payment.",
  },
  retry_policy: {
    name: "Careful retries",
    explanation: "Notary never blindly repeats a write, and after a timeout it reads back first and retries only if the write clearly did not happen.",
    example: "A refund call times out, Notary reads back and finds the refund already exists, so it does not send it again.",
  },
  paginate_fully: {
    name: "Read every page",
    explanation: "Notary keeps fetching pages until an empty one comes back, so nothing is cut off.",
    example: "To find existing refunds, Notary reads pages of 100 until a page comes back empty.",
  },
  block: {
    name: "Refuse",
    explanation: "Notary refuses the call outright because no safe fix is known, and the item is held for a person.",
    example: "If a wallet balance arrives in an unexpected form, wallet credits are refused and held for review.",
  },
};

export const BELIEF_STATUS_WORDS: Record<BeliefStatus, Words> = {
  hypothesis: {
    name: "Hypothesis",
    explanation: "Notary has an idea about this promise but not enough evidence yet either way.",
    example: "After one test, Notary suspects the page limit is not enforced but needs more tests to be sure.",
  },
  candidate: {
    name: "Candidate",
    explanation: "At least two independent tests strongly agree, and the result is waiting for a reviewer to check it.",
    example: "Two different tests both show refund amounts read back unchanged, so the belief waits for review.",
  },
  notarized: {
    name: "Notarized",
    explanation: "A reviewer checked the raw test records and agreed, so Notary now trusts this belief and may act on it.",
    example: "The reviewer upholds that refund amounts are in cents, so refunds that depend on it may go through.",
  },
  refuted: {
    name: "Refuted",
    explanation: "The evidence went against this belief, so Notary does not rely on it.",
    example: "An idea that balances arrive as text is ruled out when every test returns a whole number.",
  },
  abstained: {
    name: "Abstained",
    explanation: "Notary ran out of test budget before the evidence was clear, so it makes no call either way.",
    example: "After five tests the results still point both ways, so actions that need this promise are held.",
  },
  unlearned: {
    name: "Unlearned",
    explanation: "Something Notary had trusted stopped matching new evidence, so it withdrew that trust and retired the guards built on it.",
    example: "After the tool changes how it pages results, the old page-limit belief is unlearned and its guard is switched off.",
  },
};

export const DECISION_STATUS_WORDS: Record<DecisionStatus, Words> = {
  executed: {
    name: "Executed",
    explanation: "Notary carried out the action, such as a refund or a plan change, through its guards.",
    example: "A refund for a small self-serve customer is sent to Dodo and succeeds.",
  },
  held: {
    name: "Held",
    explanation: "Notary paused the action for a person because something it needed was not proven safe yet.",
    example: "A refund waits for review because the belief about refund units is not notarized yet.",
  },
  escalated: {
    name: "Escalated",
    explanation: "The billing policy says a person must decide this request, so Notary passed it on.",
    example: "A contract customer asks for a full refund, so the account manager decides.",
  },
  denied: {
    name: "Denied",
    explanation: "Notary turned the request down because the billing policy says no or the money was already returned.",
    example: "A refund request for a payment that already has a refund is denied.",
  },
};

export const PROBE_VERDICT_WORDS: Record<ProbeVerdict, Words> = {
  confirmed: {
    name: "Confirmed",
    explanation: "The test result matched exactly one of the competing explanations and ruled out all the others.",
    example: "Asking for 101 items returns exactly 100, which only the silent truncation explanation predicted.",
  },
  refuted: {
    name: "Refuted",
    explanation: "The test result went against the explanations being tested.",
    example: "Every explanation expected an error or a short page, but the tool returned a normal full page.",
  },
  inconclusive: {
    name: "Inconclusive",
    explanation: "The test result fit more than one explanation, so it cannot pick between them.",
    example: "A request is rejected with an error, which both the honored and the strict-limit explanations predicted.",
  },
  uninformative: {
    name: "Uninformative",
    explanation: "The test saw nothing useful, such as an empty list or a missing field, so it says nothing about the promise.",
    example: "The test account has only 3 refunds, so a page limit of 100 cannot be tested.",
  },
  invalid: {
    name: "Invalid",
    explanation: "The comparison run read the same as the real run where the two should differ, so the test itself did not work.",
    example: "Two different amounts were sent but both read back the same, so the read-back does not reflect what was sent.",
  },
};

export const POLICY_OUTCOME_WORDS: Record<PolicyOutcome, Words> = {
  approve: {
    name: "Approve",
    explanation: "The billing policy allows the request as asked.",
    example: "A small self-serve customer asks for part of a payment back and gets the amount asked.",
  },
  partial: {
    name: "Partial",
    explanation: "The billing policy allows only part of the request.",
    example: "A small business on the growth plan asks for a full refund and gets half the payment back.",
  },
  deny: {
    name: "Deny",
    explanation: "The billing policy does not allow the request.",
    example: "A starter-plan customer asks for a goodwill credit and is offered a refund instead.",
  },
  escalate: {
    name: "Escalate",
    explanation: "The billing policy says a person must decide.",
    example: "A customer whose company could not be verified asks for a refund, so a person reviews it.",
  },
};

export const PROBE_TEMPLATE_WORDS: Record<ProbeTemplate, Words> = {
  boundary_sweep: {
    name: "Edge test",
    explanation: "Try values at and just past a documented limit to see whether the limit is really enforced.",
    example: "Ask for 1, 100 and 101 refunds per page and compare what comes back.",
  },
  unit_roundtrip: {
    name: "Amount round trip",
    explanation: "Send a known amount and read it back to see whether the tool kept the same unit.",
    example: "Create a product priced 1234 and check that it reads back as 1234, not 123400.",
  },
  retry_after_timeout: {
    name: "Repeat a write",
    explanation: "Send the same write two or three times, as a client would after a timeout, then count how many records exist.",
    example: "Send the same keyed wallet credit three times and check that the ledger holds one entry.",
  },
  pagination_completeness: {
    name: "Count two ways",
    explanation: "List the same items page by page and all at once, then check that both ways give the same set.",
    example: "Walk several small pages of payments and compare them with one big page of the same payments.",
  },
  write_then_read: {
    name: "Write, then read",
    explanation: "Make a change, then read it back right away and again later to see when it shows up.",
    example: "Issue a refund, then check the payment's refund list at once, after 1 second and after 3 seconds.",
  },
  unknown_param: {
    name: "Unknown setting",
    explanation: "Send a request with a setting the tool should not accept and see whether it is rejected, ignored or used.",
    example: "Ask the identify endpoint for the headcount field group, which the docs say only enrich supports.",
  },
  type_edge: {
    name: "Type edge",
    explanation: "Read a field where unusual values are likely, such as very large numbers, and check its type matches the docs.",
    example: "Check that a large company's headcount still arrives as a whole number, not as text.",
  },
  header_burst: {
    name: "Small burst",
    explanation: "Send a short, capped burst of free read-only requests to see whether a rate limit kicks in.",
    example: "Check the credit balance a few times in quick succession and watch for status 429.",
  },
};

// ---------------------------------------------------------------------- claim entries (derived)

const TOOL_NAME: Record<Tool, string> = { crustdata: "Crustdata", dodo: "Dodo" };

/** "dodo.createWalletLedgerEntry" -> ["create", "wallet", "ledger", "entry"]. */
function opWordList(operation: string): string[] {
  const local = operation.slice(operation.indexOf(".") + 1);
  return local.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(" ").filter(Boolean);
}

function opWords(operation: string): string {
  return opWordList(operation).join(" ");
}

/** The object of the op: "createRefund" -> "refund", "listRefunds" -> "refunds". */
function opNoun(operation: string): string {
  const words = opWordList(operation);
  return words.length > 1 ? words.slice(1).join(" ") : words.join(" ");
}

function isListOp(operation: string): boolean {
  return opWordList(operation)[0] === "list";
}

function words(snake: string): string {
  return snake
    .split("_")
    .map((w) => (w === "usd" ? "USD" : w === "id" ? "ID" : w))
    .join(" ");
}

/** Path segments that only wrap the interesting field ("total" alone says nothing). */
const VAGUE_LEAVES: ReadonlySet<string> = new Set(["total"]);

/** "[].matches[].company_data.headcount.total" -> "headcount total"; "items[].amount" -> "amount". */
function pathWords(path: string): string {
  const segs = path.split(".").map((s) => s.replace(/\[\]/g, "")).filter(Boolean);
  const leaf = segs.at(-1) ?? path;
  const parent = segs.at(-2);
  return VAGUE_LEAVES.has(leaf) && parent ? `${words(parent)} ${words(leaf)}` : words(leaf);
}

function typeWords(type: string): string {
  const parts = type.split("|");
  const nullable = parts.includes("null");
  const main = parts.filter((p) => p !== "null");
  const named: Record<string, string> = {
    integer: "a whole number",
    number: "a number",
    string: "text",
    boolean: "true or false",
    object: "an object",
    array: "a list",
    "iso-datetime": "a date and time",
  };
  const base = main.map((p) => named[p] ?? p).join(" or ");
  return nullable ? `${base} (or empty)` : base;
}

/** A value that would break a `type` rule, for the example. */
function badValueFor(type: string): string {
  const main = type.split("|").filter((p) => p !== "null")[0] ?? type;
  const bad: Record<string, string> = {
    integer: "12.5 or \"1250\" (text)",
    number: "\"1250\" (text)",
    string: "a bare number",
    boolean: "\"true\" (text)",
    "iso-datetime": "a plain number",
  };
  return bad[main] ?? "a value of another type";
}

const STATUS_WORDS: Record<number, string> = {
  200: "a normal 200 reply",
  400: "a 400 (bad request) error",
  401: "a 401 (not signed in) error",
  404: "a 404 (not found) error",
  409: "a 409 (conflict) error",
  422: "a 422 (invalid input) error",
  429: "a 429 (too many requests) error",
};

function statusWords(status: number): string {
  return STATUS_WORDS[status] ?? `status ${status}`;
}

function duration(ms: number): string {
  if (ms % 1000 === 0) return ms === 1000 ? "1 second" : `${ms / 1000} seconds`;
  return `${ms} milliseconds`;
}

function items(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}

/** "a refund", "an enrich company". */
function an(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

function An(phrase: string): string {
  const s = an(phrase);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Most times a recon step of the claim sends the identical request (1 when none repeats). */
function repeats(entry: ContractEntry): number {
  return Math.max(1, ...entry.recon.filter((s) => !s.setup).map((s) => s.repeat ?? 1));
}

/** First recon step that is not setup, with its parenthetical cost note dropped, lowercased. */
function reconNote(entry: ContractEntry): string | undefined {
  const step = entry.recon.find((s) => !s.setup);
  if (!step) return undefined;
  const note = step.note.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return note ? note.charAt(0).toLowerCase() + note.slice(1) : undefined;
}

/** Short subject for the name: what the promise is about. */
function ruleSubject(rule: ExpectRule, param: string): string {
  switch (rule.kind) {
    case "maxItems":
      return `${param ? words(param) : "item count"} max ${rule.max}`;
    case "type":
      return `${pathWords(rule.field)} type`;
    case "unit":
      return `${pathWords(param)} in ${rule.unit === "minor" ? "minor units" : rule.unit}`;
    case "statusOnError":
      return param ? `status ${rule.status} (${pathWords(param)})` : `status ${rule.status}`;
    case "idempotentOnRetry":
      return "safe to retry";
    case "errorOnUnknownParam":
      return `rejects unknown ${pathWords(param)}`;
    case "fieldPresent":
      return `includes ${pathWords(rule.field)}`;
    case "consistentWithin":
      return `visible within ${duration(rule.ms)}`;
  }
}

/** One plain sentence from the expect rule (no field paths, no decimals: one period, at the end). */
function ruleExplanation(entry: ContractEntry): string {
  const { tool, operation, param, expect: rule } = entry.claim;
  const who = TOOL_NAME[tool];
  const op = opWords(operation);
  switch (rule.kind) {
    case "maxItems":
      if (isListOp(operation)) return `${who} says a page of ${opNoun(operation)} never holds more than ${items(rule.max)}.`;
      if (param) return `${who} says one ${op} request takes at most ${rule.max} ${pathWords(param)}.`;
      return repeats(entry) > 1
        ? `${who} says sending the same ${op} request ${repeats(entry)} times still leaves at most ${items(rule.max)}.`
        : `${who} says the list read after ${op} never holds more than ${items(rule.max)}.`;
    case "type":
      return `${who} says the ${pathWords(rule.field)} field in ${an(op)} response always holds ${typeWords(rule.type)}.`;
    case "unit":
      return rule.unit === "minor"
        ? `${who} says the ${pathWords(param)} sent to ${op} is counted in the smallest currency unit, such as cents for USD.`
        : `${who} says the ${pathWords(param)} sent to ${op} is counted in ${rule.unit} units.`;
    case "statusOnError":
      return rule.status < 300
        ? `${who} says ${an(op)} request whose ${pathWords(param)} match nothing still gets ${statusWords(rule.status)}, not an error.`
        : `${who} says ${an(op)} request it cannot accept is refused with ${statusWords(rule.status)}.`;
    case "idempotentOnRetry":
      return `${who} says sending the same ${op} request again never creates a second ${opNoun(operation)}.`;
    case "errorOnUnknownParam":
      return `${who} says ${an(op)} request with an unknown ${pathWords(param)} is rejected, not silently ignored.`;
    case "fieldPresent":
      return `${who} says every ${op} response includes ${pathWords(rule.field)}.`;
    case "consistentWithin":
      return `${who} says a new ${opNoun(operation)} shows up when you read it back within ${duration(rule.ms)}.`;
  }
}

/** One concrete example of the rule being tested or broken. */
function ruleExample(entry: ContractEntry): string {
  const { tool, operation, param, expect: rule } = entry.claim;
  const who = TOOL_NAME[tool];
  const op = opWords(operation);
  const note = reconNote(entry);
  switch (rule.kind) {
    case "maxItems":
      if (isListOp(operation)) return `Asking for ${rule.max + 1} ${opNoun(operation)} per page should return at most ${rule.max} or an error.`;
      if (param) return `Sending ${rule.max + 1} ${pathWords(param)} in one ${op} request should get an error, not a silent cut to ${rule.max}.`;
      return repeats(entry) > 1
        ? `If the list read after sending the same ${op} request ${repeats(entry)} times holds ${items(rule.max + 1)}, ${who} broke this promise.`
        : `If the list read after ${op} holds ${items(rule.max + 1)}, ${who} broke this promise.`;
    case "type":
      return `If the ${pathWords(rule.field)} field comes back as ${badValueFor(rule.type)} instead of ${typeWords(rule.type)}, ${who} broke this promise.`;
    case "unit": {
      const sent = pathWords(param);
      const echoed = pathWords(rule.field);
      return rule.unit === "minor"
        ? `Sending ${an(sent)} of 1234 should read back as ${an(echoed)} of 1234 (meaning $12.34), not 123400 or 12.34.`
        : `Sending ${an(sent)} of 1234 should read back as ${an(echoed)} of 1234 ${rule.unit} units.`;
    }
    case "statusOnError":
      return note
        ? `Try it: ${note}, and the reply should be status ${rule.status}.`
        : `${An(op)} request that should fail must get status ${rule.status}, not a success.`;
    case "idempotentOnRetry":
      return `Retrying ${an(op)} call after a timeout should not produce a second ${opNoun(operation)} with a new ID.`;
    case "errorOnUnknownParam":
      return `Sending ${op} with a made-up ${pathWords(param)} should return an error, not a success.`;
    case "fieldPresent":
      return `${An(op)} reply with no ${pathWords(rule.field)} field would break this promise.`;
    case "consistentWithin":
      return `A read made ${duration(rule.ms)} after ${op} that does not list the new ${opNoun(operation)} would break this promise.`;
  }
}

export function claimEntry(entry: ContractEntry): ClaimGlossaryEntry {
  const c = entry.claim;
  return {
    id: c.id,
    name: `${TOOL_NAME[c.tool]} ${opWords(c.operation)}: ${ruleSubject(c.expect, c.param)}`,
    explanation: ruleExplanation(entry),
    example: ruleExample(entry),
    tool: c.tool,
    operation: c.operation,
    docText: c.docText,
    docUrl: c.docUrl,
  };
}

// ------------------------------------------------------------------------------------- build

function enumSection<T extends string>(values: readonly T[], map: Record<T, Words>): GlossaryEntry[] {
  return values.map((id) => {
    const w = map[id];
    if (!w) throw new Error(`glossary: no words for enum value ${JSON.stringify(id)}`);
    return { id, name: w.name, explanation: w.explanation, example: w.example };
  });
}

export function buildGlossary(contracts: readonly ContractEntry[] = allContracts): Glossary {
  const sections: Glossary["sections"] = {
    claims: contracts.map(claimEntry),
    defectClasses: enumSection(DefectClassSchema.options, DEFECT_CLASS_WORDS),
    guardKinds: enumSection(GuardKindSchema.options, GUARD_KIND_WORDS),
    beliefStatuses: enumSection(BeliefStatusSchema.options, BELIEF_STATUS_WORDS),
    decisionStatuses: enumSection(DecisionStatusSchema.options, DECISION_STATUS_WORDS),
    probeVerdicts: enumSection(ProbeVerdictSchema.options, PROBE_VERDICT_WORDS),
    policyOutcomes: enumSection(PolicyOutcomeSchema.options, POLICY_OUTCOME_WORDS),
    probeTemplates: enumSection(ProbeTemplateSchema.options, PROBE_TEMPLATE_WORDS),
  };
  const counts = Object.fromEntries(SECTION_KEYS.map((k) => [k, sections[k].length])) as Glossary["counts"];
  return GlossarySchema.parse({
    generatedBy: CONTENT_GENERATED_BY,
    note: GLOSSARY_NOTE,
    contentHash: sha256Hex(canonicalJson(sections)),
    counts,
    sections,
  });
}

/** The exact bytes written to glossary.json. */
export function renderGlossary(glossary: Glossary = buildGlossary()): string {
  return `${JSON.stringify(glossary, null, 2)}\n`;
}

export async function writeGlossary(dir: string = DEFAULT_CONTENT_DIR): Promise<{ path: string; glossary: Glossary }> {
  const glossary = buildGlossary();
  await mkdir(dir, { recursive: true });
  const path = join(dir, GLOSSARY_FILE);
  await writeFile(path, renderGlossary(glossary), "utf8");
  return { path, glossary };
}
