// Canonical JSON + content hash for run bundles (TDD: "The hash is recomputed on load so a
// tampered bundle fails visibly"). Deliberately free of node: imports: sha256 is implemented in
// plain TypeScript so packages/web can verify bundles in the browser with the same code.
import { z } from "zod";
import { RunBundleSchema } from "../schema/bundle.js";
import type { RunBundle } from "../schema/index.js";

/**
 * Stable JSON: object keys sorted (UTF-16 code unit order), no whitespace, `undefined` object
 * members omitted (as JSON.stringify does). Throws on values JSON cannot represent faithfully
 * (NaN, Infinity, bigint, functions or symbols at the top level), so two equal bundles can never
 * hash differently by accident.
 */
export function canonicalJson(value: unknown): string {
  const out = encode(value);
  if (out === undefined) throw new TypeError("canonicalJson: value is not JSON-serializable");
  return out;
}

function encode(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson: bigint is not JSON-serializable");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => encode(v) ?? "null").join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = encode(obj[key]);
    if (v !== undefined) parts.push(`${JSON.stringify(key)}:${v}`);
  }
  return `{${parts.join(",")}}`;
}

// --- sha256 (FIPS 180-4), synchronous, works in Node and browsers -------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** sha256 of a string (UTF-8) or bytes, as lowercase hex. */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >>> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLen = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

// --- bundle hashing -----------------------------------------------------------------------

const UnhashedBundleSchema = RunBundleSchema.omit({ contentHash: true });
export type UnhashedBundle = z.infer<typeof UnhashedBundleSchema>;

/** sha256 hex of canonicalJson(bundle without contentHash). */
export function computeContentHash(bundle: UnhashedBundle | RunBundle): string {
  const { contentHash: _ignored, ...rest } = bundle as RunBundle;
  return sha256Hex(canonicalJson(rest));
}

/**
 * Validate a bundle (minus its hash) and stamp contentHash. The hash is taken over the parsed
 * value, the same thing verifyBundle hashes, so writer and reader always agree.
 */
export function finalizeBundle(bundle: UnhashedBundle | RunBundle): RunBundle {
  const { contentHash: _ignored, ...rest } = bundle as RunBundle;
  const parsed = UnhashedBundleSchema.parse(rest);
  return { ...parsed, contentHash: computeContentHash(parsed) };
}

export type VerifyResult =
  | { ok: true; bundle: RunBundle }
  | { ok: false; reason: "schema"; error: string }
  // Schema-valid but the content does not match its hash: `bundle` is returned so a viewer can
  // show it next to the error; it must not be treated as trustworthy.
  | { ok: false; reason: "hash"; error: string; bundle: RunBundle };

/** zod-parse an untrusted value, then recompute and compare its content hash. */
export function verifyBundle(raw: unknown): VerifyResult {
  const parsed = RunBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "schema", error: `bundle failed schema validation:\n${z.prettifyError(parsed.error)}` };
  }
  const bundle = parsed.data;
  const actual = computeContentHash(bundle);
  if (actual !== bundle.contentHash) {
    return {
      ok: false,
      reason: "hash",
      error: `content hash mismatch for ${bundle.runId}: recorded ${bundle.contentHash}, computed ${actual}`,
      bundle,
    };
  }
  return { ok: true, bundle };
}
