import { z } from "zod";
import type { RunBundle } from "../../core/src/schema";
export const evidenceSchema = z.array(
  z.object({
    name: z.string(),
    purpose: z.string(),
    status: z.enum(["live", "pending"]),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
    notes: z.string().optional(),
  }),
);
export async function loadEvidence(signal?: AbortSignal) {
  const r = await fetch(`${import.meta.env.BASE_URL}evidence/evidence.json`, {
    signal,
    cache: "no-store",
  });
  if (
    r.status === 404 ||
    (r.ok && !r.headers.get("content-type")?.includes("json"))
  )
    return [];
  if (!r.ok) throw new Error("Tool evidence could not be loaded.");
  return evidenceSchema.parse(await r.json());
}
export function landingResults(all: RunBundle[]) {
  const live = all.some((b) => !b.sample);
  const cohort = all
    .filter((b) => b.sample !== live && b.kind === "run")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    sample: !live,
    naive: cohort.find((b) => b.variant === "naive"),
    guarded: cohort.find((b) => b.variant === "guarded"),
  };
}
