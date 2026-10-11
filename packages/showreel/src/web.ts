// The web app, read-only: the determinism patch first, then its tokens, brand primitives, landing
// styles and the global base its components expect. Components import their own kit/page CSS.
import "./determinism";
import "@web/design/tokens.css";
import "@web/design/brand.css";
import "@web/landing.css";
import "./film.css";
