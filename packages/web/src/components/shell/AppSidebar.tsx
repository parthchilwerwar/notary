import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { matchAppRoute, navRoutes, routeById, type AppRoute } from "../../routes";
import { useData } from "../../app/catalog";
import { withRun } from "../../app/links";
import { number } from "../../data";
import { ASK_KEYSHORTCUTS, ASK_SHORTCUT_LABEL, useAsk } from "../ask";
import { modeLabel, useShellStatus } from "./status";

/** The sidebar entry a pathname belongs to (a record page highlights its list page). */
export function activeNavId(pathname: string): string | undefined {
  let route: AppRoute | undefined = matchAppRoute(pathname)?.route;
  while (route && !route.nav && route.parent) route = routeById(route.parent);
  return route?.nav ? route.id : undefined;
}

export function AppSidebar({ dark, setDark }: { dark: boolean; setDark: (dark: boolean) => void }) {
  const { pathname } = useLocation();
  const { selectedRunId } = useData();
  const { health, approvals } = useShellStatus();
  const { setOpenMobile, openMobile, isMobile } = useSidebar();
  const firstLink = useRef<HTMLAnchorElement>(null);
  const ask = useAsk();
  const active = activeNavId(pathname);
  const mode = modeLabel(health);
  // Opening the drawer moves focus into it; closing returns focus to the top-bar trigger.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!isMobile) return;
    if (openMobile) firstLink.current?.focus();
    else if (wasOpen.current) document.querySelector<HTMLButtonElement>(".app-topbar .sidebar-trigger")?.focus();
    wasOpen.current = openMobile;
  }, [openMobile, isMobile]);
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };
  const waiting = approvals.state === "ready" ? approvals.pending : undefined;

  return (
    <Sidebar aria-label="Dashboard">
      <SidebarHeader>
        <Link className="brand" to="/" translate="no" onClick={close}>
          Notary
        </Link>
        {isMobile && (
          <button type="button" className="sidebar-close" onClick={() => setOpenMobile(false)}>
            Close
          </button>
        )}
      </SidebarHeader>
      <SidebarContent aria-label="Pages">
        <SidebarMenu>
          {navRoutes().map((r, i) => (
            <SidebarMenuItem key={r.id}>
              <SidebarMenuButton asChild isActive={active === r.id}>
                <Link
                  ref={i === 0 ? firstLink : undefined}
                  to={withRun(r.path, selectedRunId)}
                  aria-current={active === r.id ? "page" : undefined}
                  onClick={(e) => {
                    close();
                    // "Ask" opens the panel; modified clicks (new tab) and the page itself keep the link.
                    if (
                      r.id === "ask" &&
                      active !== "ask" &&
                      e.button === 0 &&
                      !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                    ) {
                      e.preventDefault();
                      ask.setOpen(true);
                    }
                  }}
                  {...(r.id === "ask"
                    ? {
                        "aria-haspopup": "dialog" as const,
                        "aria-keyshortcuts": ASK_KEYSHORTCUTS,
                        title: `Opens the Ask panel (${ASK_SHORTCUT_LABEL})`,
                      }
                    : {})}
                >
                  <span className="sidebar-label">{r.title}</span>
                  {r.badge === "approvals" && waiting !== undefined && waiting > 0 && (
                    <SidebarMenuBadge tone="held">
                      <span aria-hidden="true">{number(waiting)}</span>
                      <span className="sr-only">
                        {approvals.state === "ready" && approvals.readOnly
                          ? `, ${number(waiting)} held in recorded runs`
                          : `, ${number(waiting)} waiting`}
                      </span>
                    </SidebarMenuBadge>
                  )}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <dl className="sidebar-status">
          <div>
            <dt>Mode</dt>
            <dd className={mode.tone === "unsafe" ? "text-unsafe" : undefined}>
              {mode.text}
              {mode.detail && <span className="sidebar-status-detail">{mode.detail}</span>}
            </dd>
          </div>
        </dl>
        <Link
          className="sidebar-footer-link"
          to={withRun("/app/report", selectedRunId)}
          aria-current={pathname.startsWith("/app/report") ? "page" : undefined}
          onClick={close}
        >
          Report
        </Link>
        <button
          type="button"
          className="sidebar-footer-link"
          aria-pressed={dark}
          onClick={() => setDark(!dark)}
        >
          <span>Dark theme</span>
          <span className="sidebar-toggle-state" aria-hidden="true">
            {dark ? "On" : "Off"}
          </span>
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
