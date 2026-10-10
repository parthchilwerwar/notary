import { useEffect, useState } from "react";
import { z } from "zod";
import type { RunBundle } from "../../core/src/schema";
import { Panel } from "./Overview";
import { Comparison } from "./Comparison";
import { safeLink } from "./data";

const evidenceSchema = z.array(
  z.object({
    name: z.string(),
    purpose: z.string(),
    status: z.enum(["live", "pending"]),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
    notes: z.string().optional(),
  }),
);
export function Evidence({ all }: { all: RunBundle[] }) {
  const [entries, setEntries] = useState<z.infer<typeof evidenceSchema>>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}evidence/evidence.json`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (
          r.status === 404 ||
          !r.headers.get("content-type")?.includes("json")
        )
          return;
        if (!r.ok) throw new Error("Evidence file could not be loaded.");
        setEntries(evidenceSchema.parse(await r.json()));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  const guarded = all.find((b) => b.sample && b.variant === "guarded");
  const naive = all.find((b) => b.sample && b.variant === "naive");
  return (
    <>
      <section className="evidence-section">
        <div className="section-heading">
          <h2>Required tools</h2>
          <p>
            Integration receipts. Status comes from the published evidence file.
          </p>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="tool-grid">
          {["neatlogs", "Entire", "cfo.ai"].map((name) => {
            const entry = entries.find(
              (e) => e.name.toLowerCase() === name.toLowerCase(),
            );
            return (
              <Panel key={name} title={name}>
                <span
                  className={`tool-status ${entry?.status === "live" ? "recorded" : ""}`}
                >
                  {entry?.status ?? "Pending"}
                </span>
                <p className="tool-purpose">{entry?.purpose ?? "Pending"}</p>
                {entry?.notes && (
                  <details className="record-details">
                    <summary>Evidence and limitations</summary>
                    <p>{entry.notes}</p>
                  </details>
                )}
                <div className="tool-links">
                  {entry?.links.map((link) =>
                    safeLink(link.url) ? (
                      <a
                        key={link.url}
                        href={safeLink(link.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {link.label} ↗
                      </a>
                    ) : (
                      <span key={link.url}>{link.label}</span>
                    ),
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <h2>Fixture demo</h2>
          <p>Simulated APIs, kept separate from integration evidence above.</p>
        </div>
        {guarded && naive ? (
          <Comparison bundle={guarded} comparison={naive} />
        ) : (
          <Panel title="Fixture comparison pending">
            <p>
              Publish both naive and guarded fixture bundles to compare the
              demo.
            </p>
          </Panel>
        )}
      </section>
    </>
  );
}
