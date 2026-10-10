import { Link, useLocation } from "react-router";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
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
import { MODE_LABEL, heldCount, withRun } from "../../state/data-mode";
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

function activeNavId(pathname: string): string | undefined {
  let route: AppRoute | undefined = matchAppRoute(pathname)?.route;
  // Record pages highlight their list page; walk up until a sidebar entry.
  while (route && !route.group && route.parent) route = routeById(route.parent);
  return route?.group ? route.id : undefined;
}

export function AppSidebar() {
  const { pathname } = useLocation();
  const { selectedRunId, mode, source, evidence } = useData();
  const { setOpenMobile, isMobile } = useSidebar();
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
        <div className="sidebar-status" title={source === "api" ? "Local notary serve reachable at /api/bundles" : "Static published files"}>
          <span className={`mode-dot mode-${mode}`} aria-hidden="true" />
          <span className="sidebar-label">
            <span className="sidebar-status-key">Data</span> {MODE_LABEL[mode]}
            {source === "api" && mode === "fixture" && " · API connected"}
          </span>
        </div>
        <div
          className="sidebar-status"
          title={neatlogs?.notes ?? "Status from public/evidence/evidence.json"}
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
