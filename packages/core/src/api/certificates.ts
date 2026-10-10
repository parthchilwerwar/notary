// GET /api/certificates and GET /api/certificates/:id (no token, read-only).
//
// Certificates derived on every request from the REAL (sample: false) hash-verified bundles this
// server sees (the same bundle directories GET /api/runs reads), with the same code path as
// `notary export --certificates` (realCertificateSources -> buildCertificates -> buildReport).
// Fixture / sample bundles never reach the build (buildCertificates also refuses them). With no
// real runs every claim is honestly "not tested" and every count is zero.
import type { Hono } from "hono";
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import { buildCertificates, buildReport, realCertificateSources } from "../certify/index.js";
import { CertificatesResponseSchema } from "../schema/api.js";
import type { CertificatesResponse } from "../schema/api.js";
import type { LoadedBundle } from "./bundle-source.js";

export interface CertificatesOptions {
  /** Every verified bundle the server sees (first directory wins per runId). */
  verifiedBundles: () => Promise<LoadedBundle[]>;
}

export async function realCertificates(opts: CertificatesOptions): Promise<CertificatesResponse> {
  const bundles = realCertificateSources((await opts.verifiedBundles()).map((l) => l.bundle).filter((b) => !b.sample));
  const set = buildCertificates(bundles, {});
  const hashes: Record<string, string> = {};
  for (const t of set.tools) hashes[`${t.tool}.json`] = sha256Hex(canonicalJson(t));
  const report = buildReport(set, hashes, (tool) => `${tool}.json`);
  return CertificatesResponseSchema.parse({ world: "real", tools: set.tools, report });
}

const CERT_OR_REV_ID = /^(cert|rev)-[0-9a-f]{16}$/;

export function mountCertificates(app: Hono, opts: CertificatesOptions): void {
  app.get("/api/certificates", async (c) => c.json(await realCertificates(opts)));

  app.get("/api/certificates/:id", async (c) => {
    const id = c.req.param("id");
    if (!CERT_OR_REV_ID.test(id)) return c.json({ error: "invalid certificate id (expected cert-<16 hex> or rev-<16 hex>)" }, 400);
    const { tools } = await realCertificates(opts);
    for (const t of tools) {
      const cert = t.certificates.find((x) => x.id === id);
      if (cert) return c.json(cert);
      const rev = t.revocations.find((x) => x.id === id);
      if (rev) return c.json(rev);
    }
    return c.json({ error: `unknown certificate ${id}` }, 404);
  });
}
