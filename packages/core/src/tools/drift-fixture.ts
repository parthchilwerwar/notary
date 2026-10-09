/**
 * Drift fixtures (TDD "Drift fixture", PRD FR-16): a copy of one REAL recorded cassette with exactly
 * one response field deliberately changed, to simulate a tool changing its behavior. Written to
 * packages/core/fixtures/drift/<name>.json by `pnpm --filter @notary/core make:drift`.
 *
 * The file is an ordinary cassette (same `exchanges`, `contentHash` recomputed over the altered
 * exchanges, so loadCassette verifies it) plus a top-level disclosure:
 *     drift: { source, sourceContentHash, exchange, path, before, after, note }
 * `note` always reads DRIFT_NOTE, so nothing downstream can mistake the fixture for real traffic.
 *
 * Exchange selector: "<requestHash>[:<occurrence>]" (occurrence default 0); a unique hash prefix of
 * at least 8 hex characters is accepted. Field path: JSONPath-style into the exchange's response
 * body, "$.items[0].amount" (the leading "$." is optional), or "$status" for the HTTP status code.
 * The field must already exist and the new value must differ from the recorded one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CASSETTE_DIR, canonicalJson, computeContentHash, listCassettes, loadCassette, saveCassette } from "./recorder.js";
import type { Cassette, Exchange } from "./recorder.js";

export const DEFAULT_DRIFT_DIR = fileURLToPath(new URL("../../fixtures/drift/", import.meta.url));

export const DRIFT_NOTE = "DRIFT FIXTURE — one response deliberately altered to simulate a tool behavior change";

export const DriftMetaSchema = z.object({
  /** Name of the real cassette this fixture was copied from. */
  source: z.string(),
  sourceContentHash: z.string(),
  /** "<requestHash>:<occurrence>" of the altered exchange. */
  exchange: z.string(),
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  note: z.literal(DRIFT_NOTE),
});
export type DriftMeta = z.infer<typeof DriftMetaSchema>;

export type DriftFixture = Cassette & { drift: DriftMeta };

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

function getAt(root: unknown, segments: readonly Segment[], path: string): { parent: Record<string, unknown> | unknown[]; key: Segment; value: unknown } {
  let cur: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    let next: unknown;
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg >= cur.length) throw new DriftFixtureError(`field ${path} does not exist in the recorded response (index ${seg})`);
      next = cur[seg];
    } else {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, seg)) {
        throw new DriftFixtureError(`field ${path} does not exist in the recorded response (at "${seg}")`);
      }
      next = (cur as Record<string, unknown>)[seg];
    }
    if (last) return { parent: cur as Record<string, unknown> | unknown[], key: seg, value: next };
    cur = next;
  }
  throw new DriftFixtureError(`empty field path ${path}`);
}

export interface MakeDriftOptions {
  /** Real cassette name (in cassetteDir) or path. */
  from: string;
  /** "<requestHash>[:<occurrence>]". */
  exchange: string;
  /** Field path; see the header. */
  path: string;
  value: unknown;
  /** Fixture name (file <driftDir>/<out>.json). */
  out: string;
  cassetteDir?: string;
  driftDir?: string;
  /** Overwrite an existing fixture of the same name. */
  force?: boolean;
}

/** Copy a real cassette with exactly one response field changed; returns the fixture and its path. */
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
  const source = loadCassette(opts.from, { dir: cassetteDir }); // verifies its content hash
  if ((source as Partial<DriftFixture>).drift !== undefined) throw new DriftFixtureError(`${opts.from} is itself a drift fixture; copy a real cassette`);
  if (!/^[A-Za-z0-9._-]+$/.test(opts.out)) throw new DriftFixtureError(`invalid fixture name ${opts.out}`);
  const outPath = join(driftDir, `${opts.out}.json`);
  if (existsSync(outPath) && !opts.force) throw new DriftFixtureError(`${outPath} already exists (pass --force to overwrite)`);

  const target = findExchange(source, opts.exchange);
  const exchanges: Exchange[] = JSON.parse(JSON.stringify(source.exchanges)) as Exchange[];
  const copy = exchanges.find((e) => e.requestHash === target.requestHash && e.occurrence === target.occurrence)!;
  const parsed = parseFieldPath(opts.path);
  let before: unknown;
  if (parsed.status) {
    if (typeof opts.value !== "number" || !Number.isInteger(opts.value)) throw new DriftFixtureError("$status must be set to an integer HTTP status");
    before = copy.status;
    copy.status = opts.value;
  } else {
    const at = getAt(copy.responseBody, parsed.segments, opts.path);
    before = at.value;
    if (Array.isArray(at.parent)) at.parent[at.key as number] = opts.value;
    else at.parent[at.key as string] = opts.value;
  }
  if (canonicalJson(before) === canonicalJson(opts.value)) throw new DriftFixtureError(`field ${opts.path} already equals ${canonicalJson(opts.value)}; a drift fixture must change it`);

  const fixture: DriftFixture = {
    name: opts.out,
    tool: source.tool,
    createdAt: source.createdAt,
    exchanges,
    contentHash: computeContentHash(exchanges),
    drift: {
      source: source.name,
      sourceContentHash: source.contentHash,
      exchange: `${target.requestHash}:${target.occurrence}`,
      path: opts.path,
      before,
      after: opts.value,
      note: DRIFT_NOTE,
    },
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
