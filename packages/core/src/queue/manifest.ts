/**
 * Seed manifest: maps the handles used in fixtures/queue/seeded.json to the real Dodo test-mode
 * ids created by scripts/seed-dodo.ts. Written only by a live seed run; never hand-written.
 *
 * Location: packages/core/fixtures/seed/manifest.json
 * Refs:     "cust:<h>", "pay:<h>", "sub:<h>", "prod:<h>"
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const DEFAULT_MANIFEST_PATH = fileURLToPath(new URL("../../fixtures/seed/manifest.json", import.meta.url));

const MinorUnits = z.number().int().nonnegative();

export const SeedManifestSchema = z.object({
  createdAt: z.string(),
  mode: z.enum(["live", "replay"]),
  /** Cassette that recorded the seeding traffic. */
  cassette: z.string(),
  customers: z.record(z.string(), z.object({ customerId: z.string(), email: z.string(), companyDomain: z.string() })),
  products: z.record(z.string(), z.object({ productId: z.string(), price: MinorUnits, currency: z.string() })),
  payments: z.record(
    z.string(),
    z.object({
      paymentId: z.string(),
      customerHandle: z.string(),
      /** Minor units (Dodo total_amount). */
      amount: MinorUnits,
      currency: z.string(),
      status: z.string(),
    }),
  ),
  subscriptions: z.record(z.string(), z.object({ subscriptionId: z.string(), customerHandle: z.string(), productHandle: z.string() })),
  /** Optional: wallet credits seeded per customer handle (minor units). */
  wallets: z.record(z.string(), z.object({ currency: z.string(), seededCredit: MinorUnits })).optional(),
});

export type SeedManifest = z.infer<typeof SeedManifestSchema>;

export const MANIFEST_MISSING_MESSAGE = "BLOCKED: no seed manifest — run scripts/seed-dodo.ts with Dodo test keys";

/** Load and validate the manifest. Throws a clear BLOCKED error when it doesn't exist. */
export function loadManifest(path: string = DEFAULT_MANIFEST_PATH): SeedManifest {
  if (!existsSync(path)) throw new Error(`${MANIFEST_MISSING_MESSAGE} (expected ${path})`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = SeedManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid seed manifest at ${path}: ${parsed.error.message}`);
  return parsed.data;
}

export const REF_KINDS = { cust: "customers", pay: "payments", sub: "subscriptions", prod: "products" } as const;
export type RefKind = keyof typeof REF_KINDS;

const REF_PATTERN = /^(cust|pay|sub|prod):([A-Za-z0-9._-]+)$/;

export function isRef(value: string): boolean {
  return REF_PATTERN.test(value);
}

export function parseRef(ref: string): { kind: RefKind; handle: string } {
  const m = REF_PATTERN.exec(ref);
  if (!m) throw new Error(`Not a seed ref: "${ref}" (expected cust:<h>, pay:<h>, sub:<h> or prod:<h>)`);
  return { kind: m[1] as RefKind, handle: m[2]! };
}

export type ResolvedEntry =
  | { kind: "cust"; handle: string; id: string; entry: SeedManifest["customers"][string] }
  | { kind: "pay"; handle: string; id: string; entry: SeedManifest["payments"][string] }
  | { kind: "sub"; handle: string; id: string; entry: SeedManifest["subscriptions"][string] }
  | { kind: "prod"; handle: string; id: string; entry: SeedManifest["products"][string] };

/** Resolve a ref to its manifest entry. Throws on a malformed ref or an unknown handle. */
export function resolveEntry(manifest: SeedManifest, ref: string): ResolvedEntry {
  const { kind, handle } = parseRef(ref);
  const unknown = (): never => {
    throw new Error(`Unknown seed handle "${ref}": not in the seed manifest's ${REF_KINDS[kind]}`);
  };
  switch (kind) {
    case "cust": {
      const entry = manifest.customers[handle] ?? unknown();
      return { kind, handle, id: entry.customerId, entry };
    }
    case "pay": {
      const entry = manifest.payments[handle] ?? unknown();
      return { kind, handle, id: entry.paymentId, entry };
    }
    case "sub": {
      const entry = manifest.subscriptions[handle] ?? unknown();
      return { kind, handle, id: entry.subscriptionId, entry };
    }
    case "prod": {
      const entry = manifest.products[handle] ?? unknown();
      return { kind, handle, id: entry.productId, entry };
    }
  }
}

/** Resolve a ref ("pay:mid-retool-topup-001") to its Dodo id. Throws on unknown handles. */
export function resolveRef(manifest: SeedManifest, ref: string): string {
  return resolveEntry(manifest, ref).id;
}
