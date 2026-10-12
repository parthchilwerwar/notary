// public/economics.json, validated and hash-checked in the browser (the same rule as run bundles:
// sha256 of canonicalJson(file without contentHash)). Written only by `pnpm notary economics`:
// unit economics from REAL bundles plus the cfo.ai plan as exported. Never fixture data.
import { EconomicsFileSchema, type EconomicsFile } from "../../../core/src/schema";
import { canonicalJson, sha256Hex } from "../../../core/src/bundle/hash";
import { loadEconomicsPlan } from "./index";

export type EconomicsState =
  | { status: "missing" }
  | { status: "ready"; file: EconomicsFile }
  | { status: "invalid"; error: string };

/** Where the file is published and the command that writes it, for empty states. */
export const ECONOMICS_FILE = "public/economics.json";
export const ECONOMICS_COMMAND = "pnpm notary economics";
export const CFO_IMPORT_COMMAND = "pnpm notary economics --cfo-import <file>";

/** Validate + recompute the content hash. A mismatch is an error the page shows, never ignored. */
export function verifyEconomicsFile(raw: unknown): EconomicsState {
  if (raw === undefined || raw === null) return { status: "missing" };
  const parsed = EconomicsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { status: "invalid", error: `economics.json does not match its schema${first ? ` (${first.path.join(".") || "root"}: ${first.message})` : ""}. Data withheld.` };
  }
  const { contentHash, ...rest } = parsed.data;
  const actual = sha256Hex(canonicalJson(rest));
  if (actual !== contentHash)
    return { status: "invalid", error: `economics.json content hash mismatch: recorded ${contentHash.slice(0, 12)}…, computed ${actual.slice(0, 12)}…. Data withheld.` };
  return { status: "ready", file: parsed.data };
}

/** Fetch, validate and verify public/economics.json. Transport errors throw; absence is "missing". */
export async function loadEconomics(signal?: AbortSignal): Promise<EconomicsState> {
  return verifyEconomicsFile(await loadEconomicsPlan(signal));
}
