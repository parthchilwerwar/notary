// Adapted from UIAble block-footer-2. MIT (c) 2026 CodedThemes; see docs/CREDITS.md.
import { Link } from "react-router";
export function LandingFooter() {
  return (
    <footer className="landing-footer">
      <div>
        <Link className="brand" to="/">
          Notary<span className="brand-period">.</span>
        </Link>
        <p>Evidence before action.</p>
      </div>
      <nav aria-label="Footer links">
        <a
          href="https://github.com/parthchilwerwar/notary"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
        <Link to="/app">Dashboard</Link>
        <span>#neatHack</span>
      </nav>
    </footer>
  );
}
