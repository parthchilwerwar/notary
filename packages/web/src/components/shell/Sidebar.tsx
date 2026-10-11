// The white sidebar (K3): "Notary" in Instrument Serif, search, the selected-run switcher, the four
// pages (Run, Certificates, Approvals with its count, Chat), and Report + theme at the bottom. No
// mode item. Phones (< 768px): a top bar with the wordmark and a Menu button that opens the same
// sidebar as a drawer (focus moves in and stays inside, Escape or the overlay closes it, focus
// returns to Menu).
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Link, useLocation } from "react-router";
import { MoonIcon as Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { SunIcon as Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { ListIcon as List } from "@phosphor-icons/react/dist/csr/List";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { matchAppRoute, navRoutes, routeById, type AppRoute } from "../../routes";
import { useData } from "../../app/catalog";
import { withRun } from "../../app/links";
import { number } from "../../data";
import { RunPicker } from "./RunPicker";
import { MOD_KEY_LABEL } from "./keys";
import { useShellStatus } from "./status";

const MOBILE_QUERY = "(max-width: 767px)";

/** The sidebar entry a pathname belongs to (a record page highlights its list page). */
export function activeNavId(pathname: string): string | undefined {
  let route: AppRoute | undefined = matchAppRoute(pathname)?.route;
  while (route && !route.nav && route.parent) route = routeById(route.parent);
  return route?.nav ? route.id : undefined;
}

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(MOBILE_QUERY).matches === true,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

type ShellProps = { dark: boolean; setDark: (dark: boolean) => void; onPalette: () => void };

function SidebarBody({ dark, setDark, onPalette, onNavigate, firstRef }: ShellProps & { onNavigate?: () => void; firstRef?: RefObject<HTMLButtonElement | null> }) {
  const { pathname } = useLocation();
  const { selectedRunId } = useData();
  const { approvals } = useShellStatus();
  const active = activeNavId(pathname);
  // The Run page has its own run selector (?run=); a second picker would duplicate it.
  const ownPicker = matchAppRoute(pathname)?.route.id === "run";
  const waiting = approvals.state === "ready" ? approvals.pending : undefined;
  return (
    <>
      <div className="side-top">
        <Link className="side-brand" to="/" translate="no" onClick={onNavigate}>
          Notary
        </Link>
        <button
          ref={firstRef}
          type="button"
          className="side-search"
          onClick={() => {
            onNavigate?.();
            onPalette();
          }}
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <MagnifyingGlass aria-hidden="true" />
          <span>Search</span>
          <kbd aria-hidden="true">{MOD_KEY_LABEL}&nbsp;K</kbd>
        </button>
        {!ownPicker && <RunPicker />}
      </div>
      <nav className="side-nav" aria-label="Pages">
        <ul>
          {navRoutes().map((r) => (
            <li key={r.id}>
              <Link
                className="side-item"
                to={withRun(r.path, selectedRunId)}
                aria-current={active === r.id ? "page" : undefined}
                onClick={onNavigate}
              >
                <span>{r.title}</span>
                {r.badge === "approvals" && waiting !== undefined && waiting > 0 && (
                  <span className="side-badge">
                    <span aria-hidden="true">{number(waiting)}</span>
                    <span className="sr-only">
                      {approvals.state === "ready" && approvals.readOnly
                        ? `, ${number(waiting)} held in recorded runs`
                        : `, ${number(waiting)} waiting`}
                    </span>
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="side-foot">
        <Link
          className="side-item"
          to={withRun("/app/report", selectedRunId)}
          aria-current={pathname.startsWith("/app/report") ? "page" : undefined}
          onClick={onNavigate}
        >
          Report
        </Link>
        <button type="button" className="side-item side-theme" aria-pressed={dark} onClick={() => setDark(!dark)}>
          {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          <span>Dark theme</span>
          <span className="side-theme-state" aria-hidden="true">
            {dark ? "On" : "Off"}
          </span>
        </button>
      </div>
    </>
  );
}

/** Desktop sidebar (not rendered on phones). */
export function Sidebar(props: ShellProps) {
  const mobile = useIsMobile();
  if (mobile) return null;
  return (
    <aside className="side" aria-label="Dashboard">
      <SidebarBody {...props} />
    </aside>
  );
}

/** Phones: the top bar and the drawer. */
export function MobileBar(props: ShellProps) {
  const mobile = useIsMobile();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => setOpen(false), [pathname, mobile]);
  useEffect(() => {
    // Next frame: the drawer is no longer inert and has rendered.
    const frame = requestAnimationFrame(() => {
      if (open) first.current?.focus();
      else if (wasOpen.current) trigger.current?.focus();
      wasOpen.current = open;
    });
    if (!open) return () => cancelAnimationFrame(frame);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!mobile) return null;
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !drawer.current) return;
    const items = [...drawer.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), select:not([disabled])")];
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (!firstEl || !lastEl) return;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };
  return (
    <>
      <header className="mobile-bar">
        <Link className="side-brand" to="/" translate="no">
          Notary
        </Link>
        <button
          ref={trigger}
          type="button"
          className="mobile-menu"
          aria-expanded={open}
          aria-controls="app-drawer"
          onClick={() => setOpen(true)}
        >
          <List aria-hidden="true" />
          Menu
        </button>
      </header>
      {open && <div className="drawer-overlay" aria-hidden="true" onClick={() => setOpen(false)} />}
      <aside
        ref={drawer}
        id="app-drawer"
        className="side side-drawer"
        data-open={open || undefined}
        aria-label="Dashboard"
        aria-modal={open || undefined}
        role={open ? "dialog" : undefined}
        aria-hidden={!open}
        inert={!open}
        onKeyDown={trap}
      >
        <SidebarBody {...props} firstRef={first} onNavigate={() => setOpen(false)} />
      </aside>
    </>
  );
}
