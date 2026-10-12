import type { Credit } from "../../landing-data";

/**
 * Sponsor names as plain gray wordmarks (text only, no logos). Which names appear, and whether one
 * is labelled pending, comes from evidence/evidence.json (landing-data `builtWith`); `null` = not
 * loaded yet (the row keeps its height), an empty list = nothing confirmed (the section is hidden).
 */
export function BuiltWith({ credits }: { credits: Credit[] | null }) {
  if (credits && credits.length === 0) return null;
  return (
    <section className="l-built" aria-labelledby="built-title" aria-busy={credits === null || undefined}>
      <div className="l-built-inner">
        <h2 id="built-title" className="section-label l-built-label">
          Built with
        </h2>
        <ul className="l-built-list">
          {(credits ?? []).map((c) => (
            <li key={c.name} translate="no" data-pending={c.pending ? "" : undefined}>
              {c.name}
              {c.pending && (
                <span className="l-built-pending" translate="yes">
                  {" "}
                  ({c.pending})
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
