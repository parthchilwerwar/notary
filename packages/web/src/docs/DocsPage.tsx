// /docs: the Notary guide, dressed as part of the landing site: the landing's transparent nav (ink
// text, since there is no dark hero here) and footer, a fixed table of contents on the left built
// from Rare UI's Hook Sidebar (one per group; the section in view drives its rail, tracked with
// IntersectionObserver), a readable content column on the right, and a "Contents" disclosure in
// place of the sidebar under 900px. Sections come from ./content (one list).
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useLocation, useNavigate, useNavigationType } from "react-router";
import { HookSidebar } from "../components/ui/hook-sidebar";
import { Footer } from "../components/landing/Footer";
import { GITHUB_URL } from "../landing-data";
import { GROUPS, QUICK_LINKS, REPO_URL, SECTIONS, type DocSection } from "./content";
import "../landing.css";
import "./docs.css";

export const DOCS_TITLE = "Docs · Notary";
export const RARE_UI_URL = "https://rareui.com";

/** Sections per sidebar group, in page order. */
export function groupedSections(sections: DocSection[] = SECTIONS) {
  return GROUPS.map((group) => ({ group, items: sections.filter((s) => s.group === group) })).filter((g) => g.items.length > 0);
}

/** The landing's links, pointed back at the landing's sections from here. */
const SITE_LINKS = [
  { label: "How it works", href: "/#how" },
  { label: "Features", href: "/#features" },
  { label: "Chat", href: "/#chat" },
] as const;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The section in view: the first section (in page order) crossing a reading line 30% down the
 * viewport, or the last section once the end of the page is visible.
 */
function useActiveSection(ids: string[], endRef: RefObject<HTMLElement | null>): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const visible = new Set<string>();
    let atEnd = false;
    const update = () => {
      const first = atEnd ? els[els.length - 1]!.id : els.find((el) => visible.has(el.id))?.id;
      setActive(first ?? ids[0]!);
    };
    const sections = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        update();
      },
      // A thin band at 30% of the viewport height: below the sticky chrome on every screen size.
      { rootMargin: "-30% 0px -69% 0px", threshold: 0 },
    );
    els.forEach((el) => sections.observe(el));
    const end = new IntersectionObserver((entries) => {
      atEnd = entries.some((e) => e.isIntersecting);
      update();
    });
    if (endRef.current) end.observe(endRef.current);
    return () => {
      sections.disconnect();
      end.disconnect();
    };
  }, [ids, endRef]);
  return active;
}

/** The landing nav's markup and classes, pinned to ink text (no dark zone behind it on this page). */
function DocsNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return (
    <header className="l-nav docs-nav" data-tone="dark" data-scrolled={scrolled || undefined}>
      <div className="l-nav-inner">
        <Link className="l-wordmark" to="/" aria-label="Notary home" translate="no">
          Notary
        </Link>
        <nav className="l-nav-links" aria-label="Site">
          <ul>
            {SITE_LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
            <li>
              <Link to="/docs" aria-current="page">
                Docs
              </Link>
            </li>
            <li>
              <a href={GITHUB_URL} rel="noreferrer">
                GitHub
              </a>
            </li>
          </ul>
        </nav>
        <Link className="btn btn-ink l-nav-cta" to="/app">
          Open dashboard
        </Link>
      </div>
    </header>
  );
}

function TocGroups({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  return (
    <>
      {groupedSections().map(({ group, items }) => {
        const index = items.findIndex((s) => s.id === active);
        return (
          <HookSidebar
            key={group}
            as="div"
            label={group}
            className="docs-toc-group"
            items={items.map((s) => ({ label: s.title, href: `#${s.id}` }))}
            value={index}
            onChange={(i) => onSelect(items[i]!.id)}
            color="var(--accent)"
          />
        );
      })}
    </>
  );
}

function RareUiCredit({ className }: { className: string }) {
  return (
    <p className={className}>
      Sidebar component by{" "}
      <a href={RARE_UI_URL} rel="noreferrer">
        Rare UI
      </a>
    </p>
  );
}

export default function DocsPage() {
  const { hash } = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const endRef = useRef<HTMLDivElement>(null);
  const contentsRef = useRef<HTMLDetailsElement>(null);
  const ids = useMemo(() => SECTIONS.map((s) => s.id), []);
  const inView = useActiveSection(ids, endRef);
  // While a chosen section scrolls into place, the rail stays on it instead of sweeping past the
  // sections in between.
  const [pinned, setPinned] = useState<string | null>(null);
  const active = pinned ?? inView;
  const activeTitle = SECTIONS.find((s) => s.id === active)?.title ?? SECTIONS[0]!.title;

  // Title while the guide is open; the previous one comes back when leaving.
  useEffect(() => {
    const previous = document.title;
    document.title = DOCS_TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  // Smooth in-page jumps (unless reduced motion is asked for: docs.css only applies it then).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("docs-smooth");
    return () => root.classList.remove("docs-smooth");
  }, []);

  // A deep link (/docs#commands) or Back/Forward between sections: the page loads lazily, after the
  // browser's own hash jump. Sidebar choices (PUSH) scroll themselves, smoothly.
  useEffect(() => {
    if (!hash || navigationType !== "POP") return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    let cancelled = false;
    const jump = () => {
      if (!cancelled) el.scrollIntoView({ behavior: "instant", block: "start" });
    };
    // Once now, and again when the web fonts have settled the layout.
    const frame = requestAnimationFrame(jump);
    void document.fonts?.ready.then(jump);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [hash, navigationType]);

  // Release the pinned section once the scroll it started settles.
  useEffect(() => {
    if (!pinned) return;
    let timer = setTimeout(() => setPinned(null), 1200);
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setPinned(null), 120);
    };
    window.addEventListener("scrollend", settle, { once: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scrollend", settle);
    };
  }, [pinned]);

  const select = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setPinned(id);
    el.scrollIntoView({ behavior: reducedMotion() ? "instant" : "smooth", block: "start" });
    if (hash !== `#${id}`) navigate({ hash: id }, { preventScrollReset: true });
    // On phones, fold the Contents list away after a choice.
    if (contentsRef.current) contentsRef.current.open = false;
  };

  return (
    <div className="docs theme-light">
      <a className="docs-skip" href="#docs-main">
        Skip to content
      </a>
      <DocsNav />

      <div className="docs-shell">
        <aside className="docs-side">
          <nav aria-label="Guide contents" className="docs-toc">
            <TocGroups active={active} onSelect={select} />
          </nav>
          <RareUiCredit className="docs-credit" />
        </aside>

        <main id="docs-main" className="docs-main" tabIndex={-1}>
          <details className="docs-contents" ref={contentsRef}>
            <summary>
              <span className="docs-contents-label">Contents</span>
              <span className="docs-contents-current">{activeTitle}</span>
              <span className="docs-contents-chevron" aria-hidden="true" />
            </summary>
            <nav aria-label="Guide contents, compact" className="docs-toc docs-toc-compact">
              <TocGroups active={active} onSelect={select} />
            </nav>
          </details>

          <header className="docs-hero">
            <p className="section-label">The Notary guide</p>
            <h1 className="display">Install Notary and run it with confidence.</h1>
            <p className="docs-lede">
              Notary reads your payment APIs' docs, tests every promise, and certifies what holds. It won't move money on anything it hasn't
              certified. This guide takes you from a fresh clone to your first certificate.
            </p>
            <ul className="docs-quick" aria-label="Start here">
              {QUICK_LINKS.map((q) => (
                <li key={q.href}>
                  <a href={q.href} className="docs-quick-tile">
                    <span className="docs-quick-title">{q.title}</span>
                    <span className="docs-quick-text">{q.text}</span>
                    <span className="docs-quick-arrow" aria-hidden="true">
                      →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </header>

          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="docs-section" aria-labelledby={`${s.id}-heading`}>
              <p className="section-label docs-section-group">{s.group}</p>
              <h2 id={`${s.id}-heading`}>{s.title}</h2>
              <div className="docs-prose">{s.body}</div>
            </section>
          ))}

          <div className="docs-end" ref={endRef}>
            <p>
              <a href={REPO_URL} rel="noreferrer">
                Source on GitHub
              </a>
            </p>
            <RareUiCredit className="docs-credit docs-credit-end" />
          </div>
        </main>
      </div>

      <Footer />
    </div>
  );
}
