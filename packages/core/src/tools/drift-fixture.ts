/**
 * Drift fixtures (TDD "Drift fixture", PRD FR-16; audit A-16): a copy of one REAL recorded cassette
 * with its responses deliberately rewritten to simulate a tool changing its behavior. Written to
 * packages/core/fixtures/drift/<name>.json by `pnpm --filter @notary/core make:drift`.
 *
 * Two modes:
 *   behavior (A-16, the honest one): `--op <opName> [--match <path>=<json>] --set <path>=<value|expr>`
 *     rewrites EVERY exchange of that op (and match) the same way, like a real API change: all
 *     dodo.listRefunds responses now clamp, all createRefund echoes are x100, ... Exchanges where the
 *     field is missing, not numeric for an arithmetic transform, or already equal are left alone and
 *     listed under `skipped` with the reason. Zero changed exchanges is refused.
 *   exchange (legacy): `--exchange <requestHash>[:occurrence] --set <path>=<value|expr>` changes that
 *     one exchange only. A one-exchange fixture can rarely un-learn anything once replicates count
 *     once (see src/beliefs/drift.ts); it is kept for targeted tests.
 *
 * The file is an ordinary cassette (same `exchanges`, `contentHash` recomputed over the rewritten
 * exchanges, so loadCassette verifies it) plus a top-level disclosure:
 *     drift: { source, sourceContentHash, op?, match?, exchange?, path, transform,
 *              changed: [{ exchange: "<requestHash>:<occurrence>", op, before, after }], skipped, note }
 * `note` always reads DRIFT_NOTE (exchange mode) or DRIFT_NOTE_BEHAVIOR, so nothing downstream can
 * mistake the fixture for real traffic.
 *
 * Paths: `--set` is JSONPath-style into the response body, "$.items[0].amount" (the leading "$." is
 * optional), or "$status" for the HTTP status code. `--match` selects on the REQUEST body by default
 * ("$.price.price" or "$request.price.price"), or on the response with "$response.<path>", or
 * "$status"; the value is JSON and compared canonically.
 * Values: JSON (`1234`, `"text"`, `null`, `{"a":1}`) sets the field; `x<k>` multiplies a numeric
 * field by k and `div<k>` divides it by k (e.g. x100, div100). `idiv<k>` divides an integer field by
 * k only where the result is exact (amounts in minor units stay integers); any other value is left
 * unchanged and listed under `skipped` with the reason.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CASSETTE_DIR, canonicalJson, computeContentHash, listCassettes, loadCassette, saveCassette } from "./recorder.js";
import type { Cassette, Exchange } from "./recorder.js";

export const DEFAULT_DRIFT_DIR = fileURLToPath(new URL("../../fixtures/drift/", import.meta.url));

export const DRIFT_NOTE = "DRIFT FIXTURE — one response deliberately altered to simulate a tool behavior change";
export const DRIFT_NOTE_BEHAVIOR = "DRIFT FIXTURE — every matching response deliberately rewritten to simulate a tool behavior change";

const ChangedSchema = z.object({
  /** "<requestHash>:<occurrence>". */
  exchange: z.string(),
  op: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

export const DriftMetaSchema = z.object({
  /** Name of the real cassette this fixture was copied from. */
  source: z.string(),
  sourceContentHash: z.string(),
  /** Behavior mode: the op every rewritten exchange belongs to. */
  op: z.string().optional(),
  /** Behavior mode: optional selector within the op. */
  match: z.object({ path: z.string(), value: z.unknown() }).optional(),
  /** Exchange mode: "<requestHash>:<occurrence>" of the one altered exchange. */
  exchange: z.string().optional(),
  path: z.string(),
  /** "set <json>" | "x<k>" | "div<k>" | "idiv<k>". */
  transform: z.string(),
  /** Every exchange the fixture changed, with the recorded and the rewritten value. */
  changed: z.array(ChangedSchema).min(1),
  /** Matching exchanges left unchanged, with the reason. */
  skipped: z.array(z.object({ exchange: z.string(), reason: z.string() })).default([]),
  /** Exchange mode only (kept for the one-field disclosure). */
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  note: z.union([z.literal(DRIFT_NOTE), z.literal(DRIFT_NOTE_BEHAVIOR)]),
});
export type DriftMeta = z.infer<typeof DriftMetaSchema>;

export type DriftFixture = Cassette & { drift: DriftMeta };

/** "<requestHash>:<occurrence>" keys of every exchange a drift fixture changed. */
export function driftedExchangeKeys(meta: DriftMeta): Set<string> {
  return new Set(meta.changed.map((c) => c.exchange));
}

export class DriftFixtureError extends Error {
  /** True when the refusal is a missing prerequisite (no real cassette), reported as BLOCKED. */
  readonly blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.name = "DriftFixtureError";
    this.blocked = blocked;
  }
}

type Segment = string | number;

/** "$.a.b[0].c" | "a.b[0].c" -> ["a", "b", 0, "c"]; "$status" -> the status code (null). */
export function parseFieldPath(path: string): { status: true } | { status: false; segments: Segment[] } {
  const p = path.trim();
  if (p === "$status") return { status: true };
  const body = p.startsWith("$.") ? p.slice(2) : p === "$" ? "" : p.startsWith("$") ? p.slice(1) : p;
  if (body === "") throw new DriftFixtureError(`field path "${path}" names the whole response body; name one field`);
  const segments: Segment[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body)) !== null) {
    segments.push(m[2] !== undefined ? Number(m[2]) : m[1]!);
    consumed += m[0].length;
  }
  const dots = (body.match(/\./g) ?? []).length;
  if (segments.length === 0 || consumed + dots !== body.length) throw new DriftFixtureError(`cannot parse field path "${path}" (use $.a.b[0].c or $status)`);
  return { status: false, segments };
}

/** "<path>=<json>": split on the first "=" and JSON-parse the value. */
export function parseAssignment(arg: string): { path: string; value: unknown } {
  const i = arg.indexOf("=");
  if (i <= 0) throw new DriftFixtureError(`--set needs <jsonPath>=<json value>, got "${arg}"`);
  const path = arg.slice(0, i);
  const raw = arg.slice(i + 1);
  try {
    return { path, value: JSON.parse(raw) as unknown };
  } catch {
    throw new DriftFixtureError(`--set value must be JSON (e.g. 1234, "text", null, {"a":1}); got ${raw}`);
  }
}

/** `exact`: integer division only (`idiv<k>`); a value it doesn't divide exactly is left unchanged (skipped). */
export type DriftTransform = { kind: "set"; value: unknown } | { kind: "scale"; factor: number } | { kind: "divide"; divisor: number; exact?: true };

/** "x100" / "*100" -> scale, "div100" / "/100" -> divide, "idiv100" -> exact integer divide, anything else JSON -> set. */
export function parseTransform(raw: string): DriftTransform {
  const s = raw.trim();
  const mul = /^(?:x|\*)(\d+(?:\.\d+)?)$/.exec(s);
  if (mul) return { kind: "scale", factor: Number(mul[1]) };
  const idiv = /^idiv(\d+)$/.exec(s);
  if (idiv) {
    const divisor = Number(idiv[1]);
    if (divisor === 0) throw new DriftFixtureError(`--set ${s}: cannot divide by zero`);
    return { kind: "divide", divisor, exact: true };
  }
  const div = /^(?:div|\/)(\d+(?:\.\d+)?)$/.exec(s);
  if (div) {
    const divisor = Number(div[1]);
    if (divisor === 0) throw new DriftFixtureError(`--set ${s}: cannot divide by zero`);
    return { kind: "divide", divisor };
  }
  try {
    return { kind: "set", value: JSON.parse(s) as unknown };
  } catch {
    throw new DriftFixtureError(`--set value must be JSON (e.g. 1234, "text", null, {"a":1}) or an expression (x100, div100, idiv100); got ${raw}`);
  }
}

/** "<path>=<json | x<k> | div<k> | idiv<k>>". */
export function parseSetArg(arg: string): { path: string; transform: DriftTransform } {
  const i = arg.indexOf("=");
  if (i <= 0) throw new DriftFixtureError(`--set needs <jsonPath>=<value>, got "${arg}"`);
  return { path: arg.slice(0, i), transform: parseTransform(arg.slice(i + 1)) };
}

/** "<path>=<json>" for --match. */
export function parseMatchArg(arg: string): { path: string; value: unknown } {
  const i = arg.indexOf("=");
  if (i <= 0) throw new DriftFixtureError(`--match needs <jsonPath>=<json value>, got "${arg}"`);
  const raw = arg.slice(i + 1);
  try {
    return { path: arg.slice(0, i), value: JSON.parse(raw) as unknown };
  } catch {
    throw new DriftFixtureError(`--match value must be JSON (e.g. 1234, "text", null); got ${raw}`);
  }
}

export function describeTransform(t: DriftTransform): string {
  if (t.kind === "scale") return `x${t.factor}`;
  if (t.kind === "divide") return `${t.exact ? "idiv" : "div"}${t.divisor}`;
  return `set ${canonicalJson(t.value)}`;
}

/** Apply a transform to a recorded value; a string reason when it does not apply. */
function applyTransform(t: DriftTransform, before: unknown): { after: unknown } | { skip: string } {
  if (t.kind === "set") return { after: t.value };
  if (typeof before !== "number" || !Number.isFinite(before)) return { skip: `${describeTransform(t)} needs a number, the recorded value is ${canonicalJson(before ?? null)}` };
  if (t.kind === "divide" && t.exact && (!Number.isInteger(before) || before % t.divisor !== 0)) {
    return { skip: `${describeTransform(t)} needs an integer multiple of ${t.divisor}, the recorded value is ${canonicalJson(before)}` };
  }
  const raw = t.kind === "scale" ? before * t.factor : before / t.divisor;
  // toPrecision(15) drops binary noise (12.34 * 100 = 1233.9999999999998 -> 1234).
  return { after: Number(raw.toPrecision(15)) };
}

function findExchange(cassette: Cassette, selector: string): Exchange {
  const [hashPart, occPart] = selector.split(":");
  const hash = (hashPart ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(hash)) throw new DriftFixtureError(`--exchange needs a request hash (>= 8 hex chars)[:occurrence], got "${selector}"`);
  const occurrence = occPart === undefined ? 0 : Number(occPart);
  if (!Number.isInteger(occurrence) || occurrence < 0) throw new DriftFixtureError(`bad occurrence in "${selector}"`);
  const hashes = [...new Set(cassette.exchanges.map((e) => e.requestHash).filter((h) => h.startsWith(hash)))];
  if (hashes.length === 0) throw new DriftFixtureError(`no exchange with request hash ${hash} in cassette ${cassette.name}`);
  if (hashes.length > 1) throw new DriftFixtureError(`request hash prefix ${hash} is ambiguous in ${cassette.name} (${hashes.length} matches)`);
  const ex = cassette.exchanges.find((e) => e.requestHash === hashes[0] && e.occurrence === occurrence);
  if (!ex) throw new DriftFixtureError(`request ${hashes[0]!.slice(0, 12)} has no occurrence ${occurrence} in ${cassette.name}`);
  return ex;
}

class MissingField extends DriftFixtureError {}

function getAt(root: unknown, segments: readonly Segment[], path: string): { parent: Record<string, unknown> | unknown[]; key: Segment; value: unknown } {
  let cur: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    let next: unknown;
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg >= cur.length) throw new MissingField(`field ${path} does not exist in the recorded response (index ${seg})`);
      next = cur[seg];
    } else {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, seg)) {
        throw new MissingField(`field ${path} does not exist in the recorded response (at "${seg}")`);
      }
      next = (cur as Record<string, unknown>)[seg];
    }
    if (last) return { parent: cur as Record<string, unknown> | unknown[], key: seg, value: next };
    cur = next;
  }
  throw new DriftFixtureError(`empty field path ${path}`);
}

/** Rewrite one exchange's field in place; returns before/after, or a skip reason. */
function rewrite(ex: Exchange, path: string, t: DriftTransform): { before: unknown; after: unknown } | { skip: string } {
  const parsed = parseFieldPath(path);
  if (parsed.status) {
    const res = applyTransform(t, ex.status);
    if ("skip" in res) return res;
    if (typeof res.after !== "number" || !Number.isInteger(res.after)) throw new DriftFixtureError("$status must be set to an integer HTTP status");
    const before = ex.status;
    if (before === res.after) return { skip: `$status already equals ${before}` };
    ex.status = res.after;
    return { before, after: res.after };
  }
  let at;
  try {
    at = getAt(ex.responseBody, parsed.segments, path);
  } catch (err) {
    if (err instanceof MissingField) return { skip: err.message };
    throw err;
  }
  const res = applyTransform(t, at.value);
  if ("skip" in res) return res;
  if (canonicalJson(at.value ?? null) === canonicalJson(res.after ?? null)) return { skip: `field ${path} already equals ${canonicalJson(res.after ?? null)}` };
  if (Array.isArray(at.parent)) at.parent[at.key as number] = res.after;
  else at.parent[at.key as string] = res.after;
  return { before: at.value, after: res.after };
}

/** Does the exchange satisfy `--match`? Missing paths never match. */
function matches(ex: Exchange, match: { path: string; value: unknown }): boolean {
  const p = match.path.trim();
  const want = canonicalJson(match.value ?? null);
  if (p === "$status") return canonicalJson(ex.status) === want;
  let root: unknown = ex.requestBody;
  let rest = p;
  if (p.startsWith("$response.")) {
    root = ex.responseBody;
    rest = `$.${p.slice("$response.".length)}`;
  } else if (p.startsWith("$request.")) {
    rest = `$.${p.slice("$request.".length)}`;
  }
  const parsed = parseFieldPath(rest);
  if (parsed.status) return canonicalJson(ex.status) === want;
  try {
    return canonicalJson(getAt(root, parsed.segments, p).value ?? null) === want;
  } catch (err) {
    if (err instanceof MissingField) return false;
    throw err;
  }
}

export interface MakeDriftOptions {
  /** Real cassette name (in cassetteDir) or path. */
  from: string;
  /** Behavior mode: rewrite every exchange of this op (exactly one of op / exchange). */
  op?: string;
  /** Behavior mode: only exchanges where this path equals this value (see the header). */
  match?: { path: string; value: unknown };
  /** Exchange mode: "<requestHash>[:<occurrence>]". */
  exchange?: string;
  /** Field path; see the header. */
  path: string;
  /** The rewrite: a transform, or `value` (shorthand for {kind:"set", value}). */
  transform?: DriftTransform;
  value?: unknown;
  /** Fixture name (file <driftDir>/<out>.json). */
  out: string;
  cassetteDir?: string;
  driftDir?: string;
  /** Overwrite an existing fixture of the same name. */
  force?: boolean;
}

/** Copy a real cassette with the requested responses rewritten; returns the fixture and its path. */
export function makeDriftFixture(opts: MakeDriftOptions): { fixture: DriftFixture; path: string } {
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
  const driftDir = opts.driftDir ?? DEFAULT_DRIFT_DIR;
  const byPath = opts.from.endsWith(".json") && (opts.from.includes("/") || opts.from.includes("\\"));
  const exists = byPath ? existsSync(opts.from) : listCassettes(cassetteDir).includes(opts.from.replace(/\.json$/, ""));
  if (!exists) {
    throw new DriftFixtureError(
      `BLOCKED: source cassette ${opts.from} not found${byPath ? "" : ` in ${cassetteDir}`} — a drift fixture can only be copied from a real recorded cassette (none was created)`,
      true,
    );
  }
  if ((opts.op === undefined) === (opts.exchange === undefined)) throw new DriftFixtureError("make:drift needs exactly one of --op (behavior rewrite) or --exchange (one exchange)");
  if (opts.match && opts.op === undefined) throw new DriftFixtureError("--match only applies with --op");
  if (opts.transform === undefined && opts.value === undefined) throw new DriftFixtureError("make:drift needs a value (--set <path>=<value>)");
  const transform: DriftTransform = opts.transform ?? { kind: "set", value: opts.value };
  const source = loadCassette(opts.from, { dir: cassetteDir }); // verifies its content hash
  if ((source as Partial<DriftFixture>).drift !== undefined) throw new DriftFixtureError(`${opts.from} is itself a drift fixture; copy a real cassette`);
  // A FIXTURE source (simulated traffic, `notary demo --fixture`) yields a FIXTURE drift fixture, and
  // never lands in fixtures/drift, which holds drift fixtures derived from real recorded traffic only.
  const fromFixture = source.fixture === true;
  if (fromFixture && resolve(driftDir) === resolve(DEFAULT_DRIFT_DIR)) {
    throw new DriftFixtureError(`${opts.from} is a FIXTURE cassette (simulated traffic); its drift fixture can't be written to ${DEFAULT_DRIFT_DIR}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(opts.out)) throw new DriftFixtureError(`invalid fixture name ${opts.out}`);
  const outPath = join(driftDir, `${opts.out}.json`);
  if (existsSync(outPath) && !opts.force) throw new DriftFixtureError(`${outPath} already exists (pass --force to overwrite)`);
  parseFieldPath(opts.path); // fail fast on a bad path

  const exchanges: Exchange[] = JSON.parse(JSON.stringify(source.exchanges)) as Exchange[];
  const key = (e: Exchange): string => `${e.requestHash}:${e.occurrence}`;
  const changed: DriftMeta["changed"] = [];
  const skipped: DriftMeta["skipped"] = [];
  let meta: Omit<DriftMeta, "changed" | "skipped" | "note">;

  if (opts.exchange !== undefined) {
    const target = findExchange(source, opts.exchange);
    const copy = exchanges.find((e) => e.requestHash === target.requestHash && e.occurrence === target.occurrence)!;
    const r = rewrite(copy, opts.path, transform);
    if ("skip" in r) {
      if (/does not exist/.test(r.skip)) throw new DriftFixtureError(r.skip);
      throw new DriftFixtureError(`${r.skip}; a drift fixture must change it`);
    }
    changed.push({ exchange: key(copy), op: copy.op, before: r.before, after: r.after });
    meta = { source: source.name, sourceContentHash: source.contentHash, exchange: key(copy), path: opts.path, transform: describeTransform(transform), before: r.before, after: r.after };
  } else {
    const selected = exchanges.filter((e) => e.op === opts.op && (!opts.match || matches(e, opts.match)));
    for (const ex of selected) {
      const r = rewrite(ex, opts.path, transform);
      if ("skip" in r) skipped.push({ exchange: key(ex), reason: r.skip });
      else changed.push({ exchange: key(ex), op: ex.op, before: r.before, after: r.after });
    }
    if (changed.length === 0) {
      const sel = `op ${opts.op}${opts.match ? ` where ${opts.match.path} = ${canonicalJson(opts.match.value ?? null)}` : ""}`;
      throw new DriftFixtureError(
        `the rewrite changes zero exchanges: ${selected.length} exchange(s) of ${source.name} match ${sel}` +
          (skipped.length ? ` and every one was left unchanged (${skipped[0]!.reason}${skipped.length > 1 ? `; +${skipped.length - 1} more` : ""})` : "") +
          " — no fixture was written",
      );
    }
    meta = { source: source.name, sourceContentHash: source.contentHash, op: opts.op!, ...(opts.match ? { match: opts.match } : {}), path: opts.path, transform: describeTransform(transform) };
  }

  const fixture: DriftFixture = {
    name: opts.out,
    tool: source.tool,
    createdAt: source.createdAt,
    exchanges,
    contentHash: computeContentHash(exchanges),
    ...(fromFixture ? { fixture: true as const } : {}),
    drift: { ...meta, changed, skipped, note: opts.exchange !== undefined ? DRIFT_NOTE : DRIFT_NOTE_BEHAVIOR },
  };
  const path = saveCassette(fixture, driftDir);
  return { fixture, path };
}

/** Load a drift fixture by name (in driftDir) or path; verifies the hash and the drift disclosure. */
export function loadDriftFixture(nameOrPath: string, opts: { driftDir?: string } = {}): DriftFixture {
  const file = nameOrPath.endsWith(".json") && (nameOrPath.includes("/") || nameOrPath.includes("\\"))
    ? nameOrPath
    : join(opts.driftDir ?? DEFAULT_DRIFT_DIR, `${nameOrPath.replace(/\.json$/, "")}.json`);
  if (!existsSync(file)) throw new DriftFixtureError(`drift fixture ${file} not found`, true);
  const cassette = loadCassette(file);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { drift?: unknown };
  const meta = DriftMetaSchema.safeParse(raw.drift);
  if (!meta.success) throw new DriftFixtureError(`${file} is not a drift fixture (missing or invalid "drift" disclosure)`);
  return { ...cassette, drift: meta.data };
}
