/**
 * Sidebar with the shadcn/ui `sidebar` API surface (SidebarProvider, Sidebar,
 * SidebarHeader/Content/Footer, SidebarMenu(+Item/Button/Badge), SidebarInset, SidebarTrigger,
 * useSidebar), hand-written so it needs no extra Radix packages.
 * Desktop: always expanded (text-only navigation has no icon rail to collapse to).
 * Below 768px: an off-canvas drawer with an overlay, closed by Escape, the overlay or a link.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

const MOBILE_QUERY = "(max-width: 767px)";

type SidebarState = {
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarState | null>(null);

export function useSidebar(): SidebarState {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider.");
  return ctx;
}

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
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

export function SidebarProvider({ children, className }: { children: ReactNode; className?: string }) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = useState(false);
  useEffect(() => {
    if (!openMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMobile(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMobile]);
  useEffect(() => {
    if (!isMobile) setOpenMobile(false);
  }, [isMobile]);
  const value = useMemo<SidebarState>(
    () => ({ openMobile, setOpenMobile, isMobile, toggleSidebar: () => setOpenMobile((v) => !v) }),
    [openMobile, isMobile],
  );
  return (
    <SidebarContext.Provider value={value}>
      <div className={cn("sidebar-wrapper", className)} data-mobile={isMobile ? "true" : "false"}>
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({ children, className, ...props }: ComponentProps<"aside">) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  if (isMobile)
    return (
      <>
        {openMobile && (
          <div className="sidebar-overlay" aria-hidden="true" onClick={() => setOpenMobile(false)} />
        )}
        <aside
          id="app-sidebar"
          className={cn("sidebar mobile", className)}
          data-open={openMobile ? "true" : "false"}
          aria-hidden={!openMobile}
          inert={!openMobile}
          {...props}
        >
          {children}
        </aside>
      </>
    );
  return (
    <aside id="app-sidebar" className={cn("sidebar", className)} {...props}>
      {children}
    </aside>
  );
}

export const SidebarHeader = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("sidebar-header", className)} {...p} />
);
export const SidebarContent = ({ className, ...p }: ComponentProps<"nav">) => (
  <nav className={cn("sidebar-content", className)} {...p} />
);
export const SidebarFooter = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("sidebar-footer", className)} {...p} />
);
export const SidebarMenu = ({ className, ...p }: ComponentProps<"ul">) => (
  <ul className={cn("sidebar-menu", className)} {...p} />
);
export const SidebarMenuItem = ({ className, ...p }: ComponentProps<"li">) => (
  <li className={cn("sidebar-menu-item", className)} {...p} />
);

export function SidebarMenuButton({
  asChild = false,
  isActive = false,
  className,
  ...props
}: ComponentProps<"button"> & { asChild?: boolean; isActive?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp className={cn("sidebar-menu-button", className)} data-active={isActive ? "true" : "false"} {...props} />
  );
}

/** Count next to a menu item. `held` = items waiting for a human (amber). */
export function SidebarMenuBadge({
  className,
  tone = "neutral",
  ...p
}: ComponentProps<"span"> & { tone?: "neutral" | "held" | "unsafe" }) {
  return <span className={cn("sidebar-menu-badge", `tone-${tone}`, className)} {...p} />;
}

export const SidebarInset = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("sidebar-inset", className)} {...p} />
);

/** Opens the navigation drawer (phones only; the desktop sidebar is always visible). */
export function SidebarTrigger({ className }: { className?: string }) {
  const { toggleSidebar, isMobile, openMobile } = useSidebar();
  if (!isMobile) return null;
  return (
    <button
      type="button"
      className={cn("sidebar-trigger icon-button", className)}
      onClick={toggleSidebar}
      aria-controls="app-sidebar"
      aria-expanded={openMobile}
    >
      Menu
    </button>
  );
}
