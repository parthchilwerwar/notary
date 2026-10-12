/*
 * Hook Sidebar, from Rare UI (https://rareui.com/components/hooksidebar).
 * Source: https://github.com/swamimalode07/rare-ui/blob/main/components/ui/hook-sidebar.tsx
 *
 * MIT + Commons Clause License Condition v1.0 + Attribution
 *
 * Copyright (c) 2026 Swami Malode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, and distribute the Software as part of an
 * application, website, or product, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Attribution Requirement: any project that ships any part of the Software must credit Rare UI
 * with a visible link to https://rareui.com, placed where a visitor or user can find it. The
 * credit and the copyright notice above must not be removed from the source you copied.
 *
 * Commons Clause Restriction: you may use this Software, including for any commercial purpose,
 * so long as you do not sell, sublicense, or redistribute the components themselves, whether
 * alone, in a bundle, or as a ported version.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Notary adaptation (see packages/web/docs/CREDITS.md):
 * - next/link + usePathname -> react-router <Link> + useLocation. Route items ("/app/run") render
 *   as <Link>; in-page items ("#install") render as plain <a href="#id"> so deep links, middle
 *   click and keyboard work, and a plain click hands the jump to `onChange`.
 * - `as="div"` renders the group without its own <nav> landmark (role="group"), for several
 *   groups inside one labelled <nav>.
 * - Items may carry a trailing `badge`, a per-item `onClick`, `active` and `className`.
 * - Colors map to Notary tokens: inactive rows use --text-muted (AA on white), active and hover
 *   rows --text; the hover rail is --text-faint (a non-text mark). Default rail color: --accent.
 * - Springs and reduced-motion handling are unchanged.
 */
import { useEffect, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "../../lib/utils";

const CORNER = 6;
const DASH = "repeating-linear-gradient(to top, transparent 0 2px, currentColor 2px 4px)";

export type HookSidebarItem =
  | string
  | {
      label: string;
      href?: string;
      /** Shown after the label (a count, a status); not part of the accessible label unless it renders text. */
      badge?: ReactNode;
      /** Called on a plain click, before `onChange` (e.g. to close a drawer). */
      onClick?: () => void;
      /** Overrides the default route match (pathname equals href without its query). */
      active?: boolean;
      /** Extra classes for this row. */
      className?: string;
    };

export type HookSidebarProps = Omit<ComponentProps<"nav">, "onChange" | "ref"> & {
  items: HookSidebarItem[];
  label?: string;
  value?: number;
  defaultValue?: number;
  onChange?: (index: number) => void;
  color?: string;
  dashed?: boolean;
  /** "nav" (default) is a landmark; "div" is a labelled group inside an outer <nav>. */
  as?: "nav" | "div";
};

const objectOf = (item: HookSidebarItem) => (typeof item === "string" ? undefined : item);
const hrefOf = (item: HookSidebarItem) => objectOf(item)?.href;
const labelOf = (item: HookSidebarItem) => (typeof item === "string" ? item : item.label);
const isHash = (href: string | undefined) => href !== undefined && href.startsWith("#");
const pathOf = (href: string) => href.split(/[?#]/)[0];

/** A plain left click (no modifier): the ones the sidebar handles itself. */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

const Rail = ({
  from = 0,
  y,
  visible,
  color,
  dashed,
  className,
}: {
  from?: number;
  y: number | null;
  visible: boolean;
  color?: string;
  dashed: boolean;
  className?: string;
}) => {
  const reduced = useReducedMotion();
  const travel = reduced ? { duration: 0 } : { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.7 };

  return (
    <motion.span
      aria-hidden
      initial={false}
      style={{ color }}
      animate={{ opacity: visible && y !== null ? 1 : 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.2 }}
      className={cn("pointer-events-none absolute inset-0", className)}
    >
      <motion.span
        initial={false}
        animate={{ top: from, height: Math.max(0, (y ?? 0) - CORNER - from) }}
        transition={travel}
        style={dashed ? { backgroundImage: DASH } : { backgroundColor: "currentColor" }}
        className="absolute left-0.5 w-px"
      />
      <motion.svg
        initial={false}
        animate={{ top: (y ?? 0) - CORNER }}
        transition={travel}
        width="12"
        height="7"
        viewBox="0 0 12 7"
        fill="none"
        className="absolute left-0.5"
      >
        <path d="M0.5 0a6 6 0 0 0 6 6H12" stroke="currentColor" strokeDasharray={dashed ? "2 2" : undefined} />
      </motion.svg>
    </motion.span>
  );
};

export function HookSidebar({
  items,
  label,
  value,
  defaultValue = 0,
  onChange,
  color = "var(--accent)",
  dashed = true,
  as = "nav",
  className,
  ...props
}: HookSidebarProps) {
  const { pathname } = useLocation();
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const [centers, setCenters] = useState<number[]>([]);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);

  const routed = items.some((item) => {
    const href = hrefOf(item);
    return href !== undefined && !isHash(href);
  });
  const routeIndex = items.findIndex((item) => {
    const o = objectOf(item);
    if (o?.active !== undefined) return o.active;
    return o?.href !== undefined && !isHash(o.href) && pathOf(o.href) === pathname;
  });
  const activeIndex = value ?? (routed ? routeIndex : internalValue);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;

    const measure = () => setCenters(itemRefs.current.map((el) => (el ? el.offsetTop + el.offsetHeight / 2 : 0)));

    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [items.length]);

  const activeY = activeIndex < 0 ? null : (centers[activeIndex] ?? null);
  const hoverY = hoverIndex === null ? null : (centers[hoverIndex] ?? null);

  // above the active row the accent line already covers the span, so draw only the corner
  const hoverFrom = activeY !== null && hoverY !== null && hoverY <= activeY ? Math.max(0, hoverY - CORNER) : (activeY ?? 0);

  const select = (index: number) => {
    if (value === undefined) setInternalValue(index);
    onChange?.(index);
  };

  const labelId = label ? `hook-sidebar-${label.replace(/\W+/g, "-").toLowerCase()}` : undefined;
  const Root = as;
  const rootProps = as === "nav" ? { "aria-label": label } : label ? { role: "group", "aria-labelledby": labelId } : {};

  return (
    <Root data-slot="hook-sidebar" {...rootProps} className={cn("flex flex-col", className)} {...props}>
      {label && (
        <span
          data-slot="hook-sidebar-label"
          id={labelId}
          className="pb-3 pl-0.5 pr-2 font-sans text-xs font-medium uppercase tracking-[0.12em] text-ink-muted"
        >
          {label}
        </span>
      )}

      <div ref={listRef} onMouseLeave={() => setPointerInside(false)} className="relative flex flex-col gap-0.5">
        <Rail
          from={hoverFrom}
          y={hoverY}
          visible={(pointerInside || focusInside) && hoverIndex !== activeIndex}
          dashed={dashed}
          className="text-ink-faint"
        />
        <Rail y={activeY} visible={activeY !== null} color={color} dashed={dashed} />

        {items.map((item, index) => {
          const text = labelOf(item);
          const o = objectOf(item);
          const href = o?.href;
          const isActive = index === activeIndex;
          const setRef = (el: HTMLElement | null) => {
            itemRefs.current[index] = el;
          };
          const rowProps = {
            "data-slot": "hook-sidebar-item",
            "data-active": isActive,
            onMouseEnter: () => {
              setHoverIndex(index);
              setPointerInside(true);
            },
            onFocus: () => {
              setHoverIndex(index);
              setFocusInside(true);
            },
            onBlur: () => setFocusInside(false),
            className: cn(
              "flex items-center gap-2 rounded-lg py-1.5 pl-5 pr-2 text-left text-sm no-underline transition-colors duration-200 motion-reduce:transition-none",
              isActive ? "font-medium text-ink" : "text-ink-muted hover:text-ink",
              o?.className,
            ),
          };
          const content = (
            <>
              <span className="min-w-0">{text}</span>
              {o?.badge}
            </>
          );

          if (href && isHash(href)) {
            return (
              <a
                key={`${index}-${text}`}
                {...rowProps}
                ref={setRef}
                href={href}
                aria-current={isActive ? "location" : undefined}
                onClick={(e) => {
                  if (!plainClick(e)) return;
                  o?.onClick?.();
                  // The page scrolls and updates the hash itself; without a handler the anchor jumps.
                  if (onChange) e.preventDefault();
                  select(index);
                }}
              >
                {content}
              </a>
            );
          }
          if (href) {
            return (
              <Link
                key={`${index}-${text}`}
                {...rowProps}
                ref={setRef}
                to={href}
                aria-current={isActive ? "page" : undefined}
                onClick={(e) => {
                  if (!plainClick(e)) return;
                  o?.onClick?.();
                  select(index);
                }}
              >
                {content}
              </Link>
            );
          }
          return (
            <button
              key={`${index}-${text}`}
              {...rowProps}
              ref={setRef}
              type="button"
              aria-current={isActive ? "true" : undefined}
              onClick={() => {
                o?.onClick?.();
                select(index);
              }}
            >
              {content}
            </button>
          );
        })}
      </div>
    </Root>
  );
}
