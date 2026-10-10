import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { NAV_GROUPS, matchAppRoute, routeById, routes, type AppRoute } from "../../routes";
import { useData } from "../../state/DataProvider";
import { PUBLISHED_FILES } from "../../data";
import { MODE_LABEL, heldCount, withRun, type DataMode } from "../../state/data-mode";
import { ASK_KEYSHORTCUTS, ASK_SHORTCUT_LABEL, useAsk } from "../ask";

/** Badge counts from the current data world; undefined while unknown (never a placeholder 0). */
export function useBadges(): Record<"held" | "revocations", number | undefined> {
  const { bundle, certificates } = useData();
  return {
    held: bundle ? heldCount(bundle) : undefined,
    revocations:
      certificates.status === "ready"
        ? certificates.data.revocations.length
        : undefined,
  };
}

/** Data-mode label; never claims a mode before a verified run is selected. */
export function dataStatusLabel({
  bundle,
  loading,
  error,
  mode,
}: {
  bundle?: unknown;
  loading: boolean;
  error?: string;
  mode: DataMode;
}): string {
  if (bundle) return MODE_LABEL[mode];
  if (loading) return "Verifying…";
  if (error) return "Withheld";
  return "None published";
}

function activeNavId(pathname: string): string | undefined {
  let route: AppRoute | undefined = matchAppRoute(pathname)?.route;
  // Record pages highlight their list page; walk up until a sidebar entry.
  while (route && !route.group && route.parent) route = routeById(route.parent);
  return route?.group ? route.id : undefined;
}

export function AppSidebar() {
  const { pathname } = useLocation();
  const { selectedRunId, mode, source, evidence, bundle, loading, error } = useData();
  const dataStatus = dataStatusLabel({ bundle, loading, error, mode });
  const { setOpenMobile, openMobile, isMobile } = useSidebar();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Opening the drawer moves focus into it; closing returns focus to the top-bar trigger.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!isMobile) return;
    if (openMobile) closeRef.current?.focus();
    else if (wasOpen.current)
      document.querySelector<HTMLButtonElement>(".app-topbar .sidebar-trigger")?.focus();
    wasOpen.current = openMobile;
  }, [openMobile, isMobile]);
  const badges = useBadges();
  const ask = useAsk();
  const active = activeNavId(pathname);
  const neatlogs =
    evidence.status === "ready"
      ? evidence.data.find((e) => e.name.toLowerCase() === "neatlogs")
      : undefined;
  return (
    <Sidebar aria-label="Dashboard navigation">
      <SidebarHeader>
        <Link className="brand sidebar-brand" to="/" aria-label="Notary home">
          <span className="brand-mark">
            <ShieldCheck size={22} aria-hidden="true" />
          </span>
          <span className="sidebar-label">
            Notary<span className="brand-period">.</span>
          </span>
        </Link>
        {isMobile && (
          <button
            type="button"
            ref={closeRef}
            className="icon-button sidebar-close"
            aria-label="Close navigation"
            onClick={() => setOpenMobile(false)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group} aria-label={group}>
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
            <SidebarMenu>
              {routes
                .filter((r) => r.group === group)
                .map((r) => {
                  const count = r.badge ? badges[r.badge] : undefined;
                  return (
                    <SidebarMenuItem key={r.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={active === r.id}
                        tooltip={r.title}
                      >
                        <Link
                          to={withRun(r.path, selectedRunId)}
                          aria-current={active === r.id ? "page" : undefined}
                          onClick={(e) => {
                            if (isMobile) setOpenMobile(false);
                            // "Ask Notary" opens the panel; modified clicks (new tab) and the
                            // full page itself keep the link to /app/ask.
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
                          {...(r.id === "ask" ? {
                            "aria-haspopup": "dialog" as const,
                            "aria-keyshortcuts": ASK_KEYSHORTCUTS,
                            title: `Open the Ask Notary panel (${ASK_SHORTCUT_LABEL})`,
                          } : {})}
                        >
                          <r.icon size={18} aria-hidden="true" />
                          <span className="sidebar-label">{r.title}</span>
                          {count !== undefined && count > 0 && (
                            <SidebarMenuBadge
                              tone={r.badge === "revocations" ? "unsafe" : "info"}
                              aria-label={`${count} ${r.badge === "held" ? "held" : "revoked"}`}
                            >
                              {count}
                            </SidebarMenuBadge>
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <div className="sidebar-status" title={source === "api" ? "Live: a local notary serve answered /api/health" : "Replay of published files"}>
          <span className={`mode-dot ${bundle ? `mode-${mode}` : "mode-pending"}`} aria-hidden="true" />
          <span className="sidebar-label">
            <span className="sidebar-status-key">Data</span> {dataStatus}
            {source === "api" && mode === "fixture" && " · API connected"}
          </span>
        </div>
        <div
          className="sidebar-status"
          title={neatlogs?.notes ?? `Status from ${PUBLISHED_FILES.evidence}`}
        >
          <span
            className={`mode-dot ${neatlogs?.status === "live" ? "mode-live" : "mode-pending"}`}
            aria-hidden="true"
          />
          <span className="sidebar-label">
            <span className="sidebar-status-key">neatlogs</span>{" "}
            {evidence.status === "loading"
              ? "…"
              : evidence.status === "error"
                ? "evidence unavailable"
                : (neatlogs?.status ?? "not listed")}
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
