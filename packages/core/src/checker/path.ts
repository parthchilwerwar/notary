/**
 * Field paths for the contract checker. Dotted keys, with `[]` meaning "each element" and `[n]`
 * (or a numeric key on an array, `items.0`) meaning one element:
 *
 *   "items[].amount"   every item's amount
 *   "[].company_data"  each element of a top-level array
 *   "items[0].id"      the first item's id
 *   ""                 the value itself
 *
 * `resolvePath` returns one hit per concrete location the path expands to, including the
 * locations where it could not be followed (found: false), so callers can tell "missing" from
 * "present with value undefined". An empty array expands to no hits (nothing to inspect).
 */

export type PathSegment = { kind: "key"; key: string } | { kind: "each" } | { kind: "index"; index: number };

export interface PathHit {
  /** Concrete path, e.g. "items[2].amount". */
  path: string;
  found: boolean;
  value?: unknown;
}

const PART = /^([^[\]]*)((?:\[\d*\])*)$/;

export function parsePath(path: string): PathSegment[] {
  const trimmed = path.trim();
  if (trimmed === "") return [];
  const out: PathSegment[] = [];
  for (const part of trimmed.split(".")) {
    const m = PART.exec(part);
    if (!m) throw new Error(`Invalid field path: ${JSON.stringify(path)}`);
    const key = m[1] ?? "";
    const brackets = m[2] ?? "";
    if (key === "" && brackets === "") throw new Error(`Invalid field path (empty segment): ${JSON.stringify(path)}`);
    if (key !== "") out.push({ kind: "key", key });
    for (const b of brackets.match(/\[\d*\]/g) ?? []) {
      const inner = b.slice(1, -1);
      out.push(inner === "" ? { kind: "each" } : { kind: "index", index: Number(inner) });
    }
  }
  return out;
}

export function formatPath(segments: PathSegment[]): string {
  let s = "";
  for (const seg of segments) s = appendSegment(s, seg);
  return s;
}

function appendSegment(prefix: string, seg: PathSegment): string {
  if (seg.kind === "key") return prefix === "" ? seg.key : `${prefix}.${seg.key}`;
  if (seg.kind === "each") return `${prefix}[]`;
  return `${prefix}[${seg.index}]`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function resolvePath(root: unknown, path: string | PathSegment[]): PathHit[] {
  const segments = typeof path === "string" ? parsePath(path) : path;
  const hits: PathHit[] = [];
  walk(root, segments, 0, "", hits);
  return hits;
}

function walk(value: unknown, segs: PathSegment[], i: number, at: string, hits: PathHit[]): void {
  if (i === segs.length) {
    hits.push({ path: at, found: true, value });
    return;
  }
  const seg = segs[i]!;
  const miss = (): void => {
    hits.push({ path: joinRest(at, segs.slice(i)), found: false });
  };
  if (seg.kind === "key") {
    if (isRecord(value) && Object.hasOwn(value, seg.key) && value[seg.key] !== undefined) {
      walk(value[seg.key], segs, i + 1, appendSegment(at, seg), hits);
    } else if (Array.isArray(value) && /^\d+$/.test(seg.key) && Number(seg.key) < value.length) {
      walk(value[Number(seg.key)], segs, i + 1, `${at}[${seg.key}]`, hits);
    } else {
      miss();
    }
    return;
  }
  if (seg.kind === "each") {
    if (!Array.isArray(value)) return miss();
    value.forEach((el, j) => walk(el, segs, i + 1, `${at}[${j}]`, hits));
    return;
  }
  if (Array.isArray(value) && seg.index < value.length) {
    walk(value[seg.index], segs, i + 1, `${at}[${seg.index}]`, hits);
  } else {
    miss();
  }
}

function joinRest(at: string, rest: PathSegment[]): string {
  let s = at;
  for (const seg of rest) s = appendSegment(s, seg);
  return s;
}

/** Values found at `path` (missing locations are dropped). */
export function valuesAt(root: unknown, path: string): unknown[] {
  return resolvePath(root, path)
    .filter((h) => h.found)
    .map((h) => h.value);
}

/** True if `needle` appears as any leaf value (string or number, compared exactly) inside `haystack`. */
export function containsValue(haystack: unknown, needle: unknown): boolean {
  if (haystack === needle) return true;
  if (typeof haystack === "number" && typeof needle === "string") return String(haystack) === needle;
  if (typeof haystack === "string" && typeof needle === "number") return haystack === String(needle);
  if (Array.isArray(haystack)) return haystack.some((v) => containsValue(v, needle));
  if (isRecord(haystack)) return Object.values(haystack).some((v) => containsValue(v, needle));
  return false;
}
