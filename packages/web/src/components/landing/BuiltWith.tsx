import { BUILT_WITH } from "../../landing-data";

/** Sponsor names as plain gray wordmarks (text only, no logos, no status claimed). */
export function BuiltWith() {
  return (
    <section className="l-built" aria-labelledby="built-title">
      <div className="l-built-inner">
        <h2 id="built-title" className="section-label l-built-label">
          Built with
        </h2>
        <ul className="l-built-list">
          {BUILT_WITH.map((name) => (
            <li key={name} translate="no">
              {name}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
