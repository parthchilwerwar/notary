/**
 * Schema for packages/web/public/evidence/evidence.json: the sponsor evidence page data
 * (neatlogs, Entire, cfo.ai). The JSON is hand-written and validated by test/publish.test.ts:
 * statuses are claims about the build, so a generator would add nothing but the appearance of
 * measurement. Rules: exactly the three required sponsors, status "live" | "pending", and only
 * links that exist (https, no placeholders, never the private GitHub repo).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const EVIDENCE_PATH = fileURLToPath(new URL("../../../web/public/evidence/evidence.json", import.meta.url));

export const SPONSOR_NAMES = ["neatlogs", "Entire", "cfo.ai"] as const;

/** Text that marks a link as invented or unfinished. */
export const PLACEHOLDER_URL = /example\.(com|org|net)|localhost|127\.0\.0\.1|placeholder|todo|tbd|xxx|changeme|your[-_]|<|>|\{|\}/i;

/** The project repo is private; it is mentioned in notes, never offered as public evidence. */
export const PRIVATE_REPO_URL = "https://github.com/parthchilwerwar/notary";

export const EvidenceLinkSchema = z
  .object({
    label: z.string().min(1),
    url: z.url({ protocol: /^https$/ }),
  })
  .strict()
  .refine((l) => !PLACEHOLDER_URL.test(l.url), { message: "placeholder link" })
  .refine((l) => !l.url.toLowerCase().startsWith(PRIVATE_REPO_URL), { message: "the project repo is private; not public evidence" });

export const SponsorEvidenceSchema = z
  .object({
    name: z.enum(SPONSOR_NAMES),
    purpose: z.string().min(20),
    status: z.enum(["live", "pending"]),
    links: z.array(EvidenceLinkSchema),
    notes: z.string().min(1),
  })
  .strict();

export const EvidenceSchema = z
  .array(SponsorEvidenceSchema)
  .length(SPONSOR_NAMES.length)
  .refine((xs) => SPONSOR_NAMES.every((n) => xs.filter((x) => x.name === n).length === 1), { message: "each sponsor exactly once" });

export type SponsorEvidence = z.infer<typeof SponsorEvidenceSchema>;

export function loadEvidence(path: string = EVIDENCE_PATH): SponsorEvidence[] {
  return EvidenceSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
