/**
 * Collapsible sidebar with the shadcn/ui `sidebar` API surface (SidebarProvider, Sidebar,
 * SidebarHeader/Content/Footer, SidebarGroup(+Label), SidebarMenu(+Item/Button/Badge),
 * SidebarInset, SidebarTrigger, useSidebar), hand-written so it needs no extra Radix packages.
 * Desktop: collapses to an icon rail (Ctrl/Cmd+B), state persisted in localStorage.
 * Below 768px: an off-canvas drawer with an overlay, closed by Escape or the overlay.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Slot } from "@radix-ui/react-slot";
import { SidebarSimpleIcon as SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "notary-sidebar";
const MOBILE_QUERY = "(max-width: 767px)";

type SidebarState = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
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

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "collapsed";
  } catch {
    return true;
  }
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

export function SidebarProvider({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const [open, setOpenState] = useState(readStored);
  const [openMobile, setOpenMobile] = useState(false);
  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value ? "expanded" : "collapsed");
    } catch {
      // storage unavailable: keep in-memory state
    }
  }, []);
  const toggleSidebar = useCallback(() => {
    if (isMobile) setOpenMobile((v) => !v);
    else setOpen(!open);
  }, [isMobile, open, setOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleSidebar();
      }
      if (e.key === "Escape") setOpenMobile(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);
  useEffect(() => {
    if (!isMobile) setOpenMobile(false);
  }, [isMobile]);
  const value = useMemo<SidebarState>(
    () => ({
      state: open ? "expanded" : "collapsed",
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar,
    }),
    [open, setOpen, openMobile, isMobile, toggleSidebar],
  );
  return (
    <SidebarContext.Provider value={value}>
      <div
        className={cn("sidebar-wrapper", className)}
        data-state={value.state}
        data-mobile={isMobile ? "true" : "false"}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({
  children,
  className,
  ...props
}: ComponentProps<"aside">) {
  const { state, isMobile, openMobile, setOpenMobile } = useSidebar();
  if (isMobile)
    return (
      <>
        {openMobile && (
          <div
            className="sidebar-overlay"
            aria-hidden="true"
            onClick={() => setOpenMobile(false)}
          />
        )}
        <aside
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
    <aside
      className={cn("sidebar", className)}
      data-state={state}
      data-collapsible={state === "collapsed" ? "icon" : ""}
      {...props}
    >
      {children}
    </aside>
  );
}

export const SidebarHeader = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("sidebar-header", className)} {...p} />
);
export const SidebarContent = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("sidebar-content", className)} {...p} />
);
export const SidebarFooter = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("sidebar-footer", className)} {...p} />
);
export const SidebarGroup = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("sidebar-group", className)} role="group" {...p} />
);
export const SidebarGroupLabel = ({
  className,
  ...p
}: ComponentProps<"div">) => (
  <div className={cn("sidebar-group-label", className)} {...p} />
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
  tooltip,
  className,
  ...props
}: ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string;
}) {
  const { state, isMobile } = useSidebar();
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn("sidebar-menu-button", className)}
      data-active={isActive ? "true" : "false"}
      title={state === "collapsed" && !isMobile ? tooltip : undefined}
      {...props}
    />
  );
}

export function SidebarMenuBadge({
  className,
  tone = "neutral",
  ...p
}: ComponentProps<"span"> & { tone?: "neutral" | "info" | "unsafe" }) {
  return (
    <span
      className={cn("sidebar-menu-badge", `tone-${tone}`, className)}
      {...p}
    />
  );
}

export const SidebarInset = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("sidebar-inset", className)} {...p} />
);

export function SidebarTrigger({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  const { toggleSidebar, state, isMobile, openMobile } = useSidebar();
  const expanded = isMobile ? openMobile : state === "expanded";
  return (
    <button
      type="button"
      className={cn("sidebar-trigger icon-button", className)}
      style={style}
      onClick={toggleSidebar}
      aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
      aria-expanded={expanded}
      title="Toggle sidebar (Ctrl+B)"
    >
      <SidebarSimple size={18} aria-hidden="true" />
    </button>
  );
}
