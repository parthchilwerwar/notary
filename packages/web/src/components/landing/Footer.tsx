import { Link } from "react-router";
import { FOOTER_LINKS } from "../../landing-data";

export function Footer() {
  return (
    <footer className="l-footer">
      <div className="l-footer-inner">
        <span className="l-wordmark l-footer-mark" translate="no">
          Notary
        </span>
        <nav aria-label="Footer">
          <ul className="l-footer-links">
            {FOOTER_LINKS.map((l) => (
              <li key={l.label}>
                {l.external ? (
                  <a href={l.href} rel="noreferrer">
                    {l.label}
                  </a>
                ) : (
                  <Link to={l.href}>{l.label}</Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <p className="l-footer-note">Built for neatHack 2026</p>
      </div>
    </footer>
  );
}
