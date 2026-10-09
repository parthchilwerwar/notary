/**
 * Contract sanity: every claim is a valid frozen-schema Claim, recon steps only use ops that
 * createTools exposes, chains only point backwards, and Crustdata recon stays inside its budget.
 * Pure data checks; nothing touches the network.
 */
import { describe, expect, it } from "vitest";
import { ClaimSchema } from "../src/schema/index.js";
import { ALL_OPS } from "../src/tools/index.js";
import {
  FROM_REF,
  RECON_PATH_PARAMS,
  allContracts,
  claimById,
  contractFor,
  crustdataContract,
  dodoContract,
} from "../src/contracts/index.js";
import type { ContractEntry, ReconStep } from "../src/contracts/index.js";

const CRUSTDATA_RECON_BUDGET = 40;
const DOC_HOSTS = { crustdata: "docs.crustdata.com", dodo: "docs.dodopayments.com" } as const;

/** Every string value anywhere inside a recon param tree. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

function identifierCount(params: Record<string, unknown>): number {
  for (const key of ["domains", "names", "crustdata_company_ids", "professional_network_profile_urls"]) {
    const list = params[key];
    if (Array.isArray(list)) return list.length;
  }
  return 1;
}

/** Per-record credit price per op, taken from the claims' costCredits. */
function costByOp(entries: readonly ContractEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const { claim } of entries) {
    const prev = out.get(claim.operation);
    const cost = claim.costCredits ?? 0;
    if (prev !== undefined && prev !== cost) throw new Error(`inconsistent costCredits for ${claim.operation}`);
    out.set(claim.operation, cost);
  }
  return out;
}

function stepCredits(step: ReconStep, costs: Map<string, number>): number {
  const perRecord = costs.get(step.op);
  if (perRecord === undefined) throw new Error(`no claim prices ${step.op}`);
  return perRecord * identifierCount(step.params) * (step.repeat ?? 1);
}

describe("contracts", () => {
  it("has a sensible number of claims per tool", () => {
    expect(crustdataContract.length).toBeGreaterThanOrEqual(8);
    expect(dodoContract.length).toBeGreaterThanOrEqual(8);
    expect(allContracts).toHaveLength(crustdataContract.length + dodoContract.length);
  });

  it("every claim parses with the frozen ClaimSchema", () => {
    for (const { claim } of allContracts) {
      const parsed = ClaimSchema.safeParse(claim);
      expect(parsed.success, `${claim.id}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });

  it("claim ids are unique, stable kebab-case and prefixed by their tool", () => {
    const ids = allContracts.map((e) => e.claim.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { claim } of allContracts) {
      expect(claim.id).toMatch(/^(crustdata|dodo)(\.[a-z0-9]+(-[a-z0-9]+)*)+$/);
      expect(claim.id.startsWith(`${claim.tool}.`)).toBe(true);
    }
  });

  it("claims sit in the right tool's contract and name a real op of that tool", () => {
    for (const { claim } of crustdataContract) expect(claim.tool).toBe("crustdata");
    for (const { claim } of dodoContract) expect(claim.tool).toBe("dodo");
    for (const { claim } of allContracts) {
      expect(ALL_OPS).toContain(claim.operation);
      expect(claim.operation.startsWith(`${claim.tool}.`)).toBe(true);
      expect(claim.endpoint).toMatch(/^(GET|POST) \//);
      expect(claim.costCredits).toBeTypeOf("number");
      if (claim.tool === "dodo") expect(claim.costCredits).toBe(0);
    }
  });

  it("docs: https on the vendor docs domain, quotes stay short", () => {
    for (const { claim } of allContracts) {
      const url = new URL(claim.docUrl);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe(DOC_HOSTS[claim.tool]);
      const quote = claim.docText.replace(/^\[implied\] /, "");
      expect(quote.split(/\s+/).length, claim.id).toBeLessThanOrEqual(25);
    }
  });

  it("recon ops exist in createTools and belong to the claim's tool", () => {
    for (const { claim, recon } of allContracts) {
      for (const step of recon) {
        expect(ALL_OPS, `${claim.id}: ${step.op}`).toContain(step.op);
        expect(step.op.startsWith(`${claim.tool}.`)).toBe(true);
        expect(step.note.length).toBeGreaterThan(0);
      }
    }
  });

  it("recon with steps has at least one non-setup step", () => {
    for (const { claim, recon } of allContracts) {
      if (recon.length > 0) expect(recon.some((s) => !s.setup), claim.id).toBe(true);
    }
  });

  it('every "$from" ref points to an earlier step', () => {
    for (const { claim, recon } of allContracts) {
      recon.forEach((step, i) => {
        for (const s of strings(step.params)) {
          if (!s.startsWith("$from")) continue;
          const m = FROM_REF.exec(s);
          expect(m, `${claim.id} step ${i}: malformed ${s}`).not.toBeNull();
          const ref = Number(m![1]);
          expect(ref, `${claim.id} step ${i}: ${s}`).toBeLessThan(i);
          expect(ref).toBeGreaterThanOrEqual(0);
        }
      });
    }
  });

  it("path-id ops carry their id param", () => {
    for (const { claim, recon } of allContracts) {
      for (const step of recon) {
        const key = RECON_PATH_PARAMS[step.op];
        if (key) expect(step.params, `${claim.id}: ${step.op}`).toHaveProperty(key);
      }
    }
  });

  it("retry and wait knobs stay inside the caps", () => {
    for (const { recon } of allContracts) {
      for (const step of recon) {
        if (step.repeat !== undefined) {
          expect(Number.isInteger(step.repeat)).toBe(true);
          expect(step.repeat).toBeGreaterThanOrEqual(1);
          expect(step.repeat).toBeLessThanOrEqual(3);
        }
        if (step.delayMs !== undefined) {
          expect(step.delayMs).toBeGreaterThanOrEqual(0);
          expect(step.delayMs).toBeLessThanOrEqual(5000);
        }
      }
    }
  });

  it(`Crustdata recon costs at most ${CRUSTDATA_RECON_BUDGET} credits`, () => {
    const costs = costByOp(crustdataContract);
    const total = crustdataContract.flatMap((e) => e.recon).reduce((sum, s) => sum + stepCredits(s, costs), 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(CRUSTDATA_RECON_BUDGET);
  });

  it("includes at least one control (honored) claim per tool with recon", () => {
    // Controls are marked in comments; structurally, check the known control ids exist.
    expect(claimById("crustdata.credits.balance-number")).toBeDefined();
    expect(claimById("dodo.product.price-minor-units")).toBeDefined();
  });

  it("lookup helpers", () => {
    expect(contractFor("crustdata")).toBe(crustdataContract);
    expect(contractFor("dodo")).toBe(dodoContract);
    expect(claimById("dodo.refund.amount-minor-units")?.operation).toBe("dodo.createRefund");
    expect(claimById("nope")).toBeUndefined();
  });

  it("covers the TDD required beliefs", () => {
    for (const id of [
      "dodo.refund.amount-minor-units",
      "dodo.refund.full-retry-no-duplicate",
      "dodo.payments.page-size-max-100",
      "dodo.refunds.page-size-max-100",
      "dodo.payment.refunds-lists-issued-refund",
      "crustdata.enrich.headcount-total-integer",
      "crustdata.enrich.funding-total-investment-number",
      "dodo.subscription.change-plan-pending-409",
      "dodo.wallet.credit-amount-minor-units",
      "dodo.wallet.idempotency-key-no-duplicate",
    ]) {
      expect(claimById(id), id).toBeDefined();
    }
  });
});
