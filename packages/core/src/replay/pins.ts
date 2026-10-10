/**
 * Cassette pins (P8). A live bundle names every cassette replay needs as `<name>@<sha256>` in
 * `bundle.cassettes` (the frozen schema keeps that field a plain string array), so replay can prove
 * it is serving exactly the recording the bundle was computed from: the file's recomputed content
 * hash must equal the pin. A bare `<name>` (no pin) is a reference without a hash.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CASSETTE_DIR, loadCassette } from "../tools/index.js";
import type { Cassette } from "../tools/index.js";

const PIN = /^(.+)@([0-9a-f]{64})$/;

export interface CassetteRef {
  name: string;
  /** sha256 of the cassette's exchanges, when pinned. */
  hash?: string;
}

export function pinRef(name: string, hash: string): string {
  return `${name}@${hash}`;
}

export function parseRef(ref: string): CassetteRef {
  const m = PIN.exec(ref);
  return m ? { name: m[1]!, hash: m[2]! } : { name: ref };
}

/** The cassette names in a bundle's `cassettes` (pins stripped). */
export function cassetteNames(refs: readonly string[]): string[] {
  return refs.map((r) => parseRef(r).name);
}

/** `name@hash` for a cassette file in `dir` (hash verified on load); the bare name when there is no file. */
export function pinIfPresent(name: string, dir: string = DEFAULT_CASSETTE_DIR): string {
  if (!existsSync(join(dir, `${name}.json`))) return name;
  return pinRef(name, loadCassette(name, { dir }).contentHash);
}

export class PinMismatchError extends Error {
  constructor(
    readonly ref: string,
    readonly detail: string,
  ) {
    super(`cassette ${ref}: ${detail}`);
    this.name = "PinMismatchError";
  }
}

/**
 * Load a pinned cassette and prove it is the pinned recording: the file's own hash must verify
 * (a tampered file throws) and must equal the pin (a re-recorded or swapped file throws).
 */
export function loadPinned(ref: string, dir: string = DEFAULT_CASSETTE_DIR): Cassette {
  const { name, hash } = parseRef(ref);
  if (!existsSync(join(dir, `${name}.json`))) throw new PinMismatchError(ref, `missing from ${dir}`);
  let cassette: Cassette;
  try {
    cassette = loadCassette(name, { dir });
  } catch (err) {
    throw new PinMismatchError(ref, err instanceof Error ? err.message : String(err));
  }
  if (cassette.fixture === true) {
    throw new PinMismatchError(ref, "FIXTURE cassette (simulated traffic from `notary demo --fixture`), never a recorded live run");
  }
  if (hash === undefined) throw new PinMismatchError(ref, "not pinned to a content hash (recorded before P8?)");
  if (cassette.contentHash !== hash) {
    throw new PinMismatchError(ref, `content hash ${cassette.contentHash.slice(0, 12)} does not match the bundle's pin ${hash.slice(0, 12)}`);
  }
  return cassette;
}
