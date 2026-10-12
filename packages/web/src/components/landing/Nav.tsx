import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { isRoute, navLinks } from "../../landing-data";

/**
 * The landing nav: a transparent sticky bar (no fill, border or shadow) with the wordmark, the
 * section links and a black "Open dashboard" button. Its text follows what sits behind it: white
 * over the deep blue of the hero and the closing band (elements marked `data-nav-dark`, from their
 * top or their `[data-nav-dark-start]` child down to their `[data-nav-dark-end]` child or bottom),
 * ink everywhere else.
 * Once the page scrolls, a fill-less backdrop blur keeps the links legible over content.
 */
export function Nav({ showPricing }: { showPricing: boolean }) {
  const bar = useRef<HTMLElement>(null);
  const [tone, setTone] = useState<"light" | "dark">("light");
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = bar.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const line = r.top + r.height / 2;
      const overDark = [...document.querySelectorAll<HTMLElement>("[data-nav-dark]")].some((zone) => {
        const z = zone.getBoundingClientRect();
        const startEl = zone.querySelector<HTMLElement>("[data-nav-dark-start]");
        const endEl = zone.querySelector<HTMLElement>("[data-nav-dark-end]");
        const start = startEl ? startEl.getBoundingClientRect().top : z.top;
        const end = endEl ? endEl.getBoundingClientRect().top : z.bottom;
        return line >= start && line < end;
      });
      setTone(overDark ? "light" : "dark");
      setScrolled(window.scrollY > 8);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Lazy sections mount after the first paint and move the zones.
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    ro?.observe(document.body);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
    };
  }, []);

  return (
    <header ref={bar} className="l-nav" data-tone={tone} data-scrolled={scrolled || undefined}>
      <div className="l-nav-inner">
        <Link className="l-wordmark" to="/" aria-label="Notary home" translate="no">
          Notary
        </Link>
        <nav className="l-nav-links" aria-label="Sections">
          <ul>
            {navLinks(showPricing).map((l) => (
              <li key={l.label}>
                {isRoute(l) ? (
                  <Link to={l.href}>{l.label}</Link>
                ) : (
                  <a href={l.href} {...(l.external ? { rel: "noreferrer" } : {})}>
                    {l.label}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <Link className="btn btn-ink l-nav-cta" to="/app">
          Open dashboard
        </Link>
      </div>
    </header>
  );
}
