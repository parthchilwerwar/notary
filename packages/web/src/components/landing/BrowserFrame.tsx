import type { ReactNode } from "react";

/**
 * A browser window: traffic-light dots, an address bar and an optional tag (e.g. the fixture
 * banner). `decorative` hides the whole frame from assistive tech and makes it inert (the hero
 * mockup); otherwise it is a plain figure around real content (the Proof chart).
 */
export function BrowserFrame({
  address,
  tag,
  title,
  decorative = false,
  className,
  children,
}: {
  address?: string;
  tag?: string;
  title?: ReactNode;
  decorative?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={["l-frame", className].filter(Boolean).join(" ")}
      {...(decorative ? { "aria-hidden": true, inert: true } : {})}
    >
      <div className="l-frame-bar">
        <span className="l-frame-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {address !== undefined && (
          <span className="l-frame-address" translate="no">
            {address}
          </span>
        )}
        {title && <span className="l-frame-title">{title}</span>}
        {tag && <span className="l-frame-tag">{tag}</span>}
      </div>
      <div className="l-frame-body">{children}</div>
    </div>
  );
}
