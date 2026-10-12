import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { isRoute, navLinks } from "../../landing-data";

/**
 * The landing nav: a transparent sticky bar (no fill, border or shadow) with the wordmark, the
 * section links and a black "Open dashboard" button. Its text follows what sits behind it: white
 * over the deep blue of the hero and the closing band (elements marked `data-nav-dark`, from their
 * top or their `[data-nav-dark-start]` child down to their `[data-nav-dark-end]` child or bottom),
 * ink everywhere else.
 * Once the page scrolls, a fill-less backdrop blur keeps the links legible over content.
 * Below 960px the section links sit behind a Menu button (a disclosure: aria-expanded; closes on
 * a link click, Escape or a click outside, and Escape returns focus to the button).
 */
export function Nav({ showPricing }: { showPricing: boolean }) {
  const bar = useRef<HTMLElement>(null);
  const [tone, setTone] = useState<"light" | "dark">("light");
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

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
        <div className="l-nav-end">
          <Link className="btn btn-ink l-nav-cta" to="/app">
            Open dashboard
          </Link>
          <button
            ref={menuButton}
            type="button"
            className="l-nav-menu-btn"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="l-nav-menu-icon" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="sr-only">Menu</span>
          </button>
        </div>
      </div>
      <nav id={menuId} className="l-nav-menu" aria-label="Sections" hidden={!open}>
        <ul>
          {navLinks(showPricing).map((l) => (
            <li key={l.label}>
              {isRoute(l) ? (
                <Link to={l.href} onClick={() => setOpen(false)}>
                  {l.label}
                </Link>
              ) : (
                <a href={l.href} onClick={() => setOpen(false)} {...(l.external ? { rel: "noreferrer" } : {})}>
                  {l.label}
                </a>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
