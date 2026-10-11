import { Link } from "react-router";
import { navLinks } from "../../landing-data";

/**
 * The landing nav: always a white floating bar (16px radius, hairline border, soft shadow, as wide
 * as the content) with dark text, from the very top of the page. Links turn accent blue on hover.
 */
export function Nav({ showPricing }: { showPricing: boolean }) {
  return (
    <header className="l-nav">
      <div className="l-nav-inner">
        <Link className="l-wordmark" to="/" aria-label="Notary home" translate="no">
          Notary
        </Link>
        <nav className="l-nav-links" aria-label="Sections">
          <ul>
            {navLinks(showPricing).map((l) => (
              <li key={l.label}>
                <a href={l.href} {...(l.external ? { rel: "noreferrer" } : {})}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <Link className="btn l-nav-cta" to="/app">
          Open dashboard
        </Link>
      </div>
    </header>
  );
}
