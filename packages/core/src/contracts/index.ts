/**
 * All contracts: the documented promises Notary checks, per tool. Claims are hand-written from the
 * official docs (see each file's header); the checker evaluates them, it never edits them.
 */
import type { Claim, Tool } from "../schema/index.js";
import { crustdataContract } from "./crustdata.js";
import { dodoContract } from "./dodo.js";
import type { ContractEntry } from "./types.js";

export type { ContractEntry, ReconParam, ReconStep } from "./types.js";
export { crustdataContract } from "./crustdata.js";
export { dodoContract } from "./dodo.js";

export const allContracts: ContractEntry[] = [...crustdataContract, ...dodoContract];

const byTool: Record<Tool, ContractEntry[]> = { crustdata: crustdataContract, dodo: dodoContract };

export function contractFor(tool: Tool): ContractEntry[] {
  return byTool[tool];
}

const byId = new Map<string, ContractEntry>(allContracts.map((e) => [e.claim.id, e]));

export function claimById(id: string): Claim | undefined {
  return byId.get(id)?.claim;
}

export function contractEntryById(id: string): ContractEntry | undefined {
  return byId.get(id);
}

/**
 * Ops whose URL carries an id take it from this recon param (positional first argument); the
 * remaining params are the op's body/query object. Ops not listed take `params` as their only
 * argument (getCreditBalance takes none).
 */
export const RECON_PATH_PARAMS: Readonly<Record<string, string>> = {
  "dodo.getPayment": "payment_id",
  "dodo.getRefund": "refund_id",
  "dodo.getSubscription": "subscription_id",
  "dodo.changeSubscriptionPlan": "subscription_id",
  "dodo.listCustomerWallets": "customer_id",
  "dodo.createWalletLedgerEntry": "customer_id",
  "dodo.listWalletLedgerEntries": "customer_id",
};

/** Pattern of a chained recon value: "$from:<stepIndex>:<path>". */
export const FROM_REF = /^\$from:(\d+):(.+)$/;
