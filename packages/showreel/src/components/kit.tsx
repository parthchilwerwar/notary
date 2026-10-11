// The web kit's pieces (packages/web/src/ui + design/brand.css), at film scale: the type is set
// larger than the web's (a 1080p frame is read from across a room, so nothing is under 22px), the
// shapes and colors are the same tokens.
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { AGENTS, type AgentId } from "../agents";
import { C, MONO, R, SANS, SHADOW_FILM, SHADOW_SOFT } from "../theme";

export type Tone = "safe" | "unsafe" | "held" | "revoked" | "neutral" | "active";

const TONES: Record<Tone, { bg: string; fg: string; dot: string; border?: string }> = {
  safe: { bg: C.certifiedBg, fg: C.certifiedText, dot: C.certified },
  unsafe: { bg: C.unsafeBg, fg: C.unsafeText, dot: C.unsafeText },
  held: { bg: C.heldBg, fg: C.heldText, dot: C.held },
  revoked: { bg: C.page, fg: C.revoked, dot: C.revoked, border: C.hairline },
  neutral: { bg: C.page, fg: C.strongMuted, dot: C.faint, border: C.hairline },
  active: { bg: C.accentSoft, fg: C.accentText, dot: C.accent },
};

/** brand.css .status: a dot and a word on a tinted pill. */
export function StatusPill({ tone, children, size = 22, style }: { tone: Tone; children: ReactNode; size?: number; style?: CSSProperties }) {
  const t = TONES[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.45,
        height: size * 1.85,
        padding: `0 ${size * 0.75}px`,
        borderRadius: R.pill,
        border: `1px solid ${t.border ?? "transparent"}`,
        background: t.bg,
        color: t.fg,
        fontFamily: SANS,
        fontSize: size,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span style={{ width: size * 0.36, height: size * 0.36, borderRadius: "50%", background: t.dot, flexShrink: 0 }} />
      <span style={{ textDecoration: tone === "revoked" ? "line-through" : undefined }}>{children}</span>
    </span>
  );
}

/** ui/AgentBadge: the agent's exact name from core/src/schema/agents.ts; rules dashed, "· rule". */
export function AgentBadge({ agent, size = 22 }: { agent: AgentId; size?: number }) {
  const a = AGENTS[agent];
  const rule = a.kind === "rule";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: size * 1.75,
        padding: `0 ${size * 0.65}px`,
        borderRadius: R.pill,
        border: `1px ${rule ? "dashed" : "solid"} ${rule ? C.controlLine : C.hairline}`,
        background: rule ? "transparent" : C.page,
        color: rule ? C.strongMuted : C.text,
        fontFamily: SANS,
        fontSize: size,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {a.name}
      {rule && <span style={{ color: C.muted, fontWeight: 400 }}>· rule</span>}
    </span>
  );
}

/** ui-card: white, hairline, 20px radius (28 for large), the soft floating shadow. */
export function Card({ children, style, large = false, pad = 32 }: { children: ReactNode; style?: CSSProperties; large?: boolean; pad?: number }) {
  return (
    <div
      style={{
        position: "relative",
        boxSizing: "border-box",
        padding: pad,
        border: `1px solid ${C.hairline}`,
        borderRadius: large ? R.section : R.card,
        background: C.page,
        boxShadow: SHADOW_FILM,
        fontFamily: SANS,
        color: C.text,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The muted line above a card's content ("Observation", "Certificate"). */
export function Kicker({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ color: C.muted, fontSize: 22, lineHeight: 1.3, fontFamily: SANS, ...style }}>{children}</span>;
}

/** Inline identifier (claim ids, operations): the sans face, tinted chip like the chat's code. */
export function Code({ children, style, chip = false }: { children: ReactNode; style?: CSSProperties; chip?: boolean }) {
  return (
    <span
      style={{
        fontFamily: SANS,
        fontVariantNumeric: "tabular-nums",
        ...(chip ? { padding: "0 6px", borderRadius: 6, background: C.subtle } : {}),
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export const mono = MONO;

/** Timeline mark: spinner (running, rotation from the frame) or a check. */
export function StepMark({ state, rotation = 0, size = 30, tone = "active" }: { state: "spin" | "check" | "dot"; rotation?: number; size?: number; tone?: "active" | "safe" }) {
  const ring = tone === "safe" ? C.certifiedText : C.accent;
  if (state === "spin")
    return (
      <span style={{ display: "inline-grid", placeItems: "center", width: size, height: size, borderRadius: "50%", border: `1.5px solid ${C.hairline}`, background: C.page, flexShrink: 0 }}>
        <span
          style={{
            width: size * 0.46,
            height: size * 0.46,
            borderRadius: "50%",
            border: `2px solid ${C.hairline}`,
            borderTopColor: C.accent,
            transform: `rotate(${rotation}deg)`,
          }}
        />
      </span>
    );
  if (state === "dot")
    return (
      <span style={{ display: "inline-grid", placeItems: "center", width: size, height: size, borderRadius: "50%", border: `1.5px solid ${C.hairline}`, background: C.page, flexShrink: 0 }}>
        <span style={{ width: size * 0.22, height: size * 0.22, borderRadius: "50%", background: C.faint }} />
      </span>
    );
  return (
    <span style={{ display: "inline-grid", placeItems: "center", width: size, height: size, borderRadius: "50%", border: `1.5px solid ${ring}`, background: C.page, color: ring, flexShrink: 0 }}>
      <svg viewBox="0 0 16 16" width={size * 0.55} height={size * 0.55} aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** brand.css .btn at film scale (secondary = white with hairline; ink = solid). */
export function Button({ children, variant = "secondary", size = 22 }: { children: ReactNode; variant?: "secondary" | "ink" | "accent"; size?: number }) {
  const v =
    variant === "ink"
      ? { background: C.text, color: "#FFFFFF", border: "transparent" }
      : variant === "accent"
        ? { background: C.accent, color: "#FFFFFF", border: "transparent" }
        : { background: C.page, color: C.text, border: C.hairline };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: size * 2.1,
        padding: `0 ${size * 0.95}px`,
        borderRadius: R.button,
        border: `1px solid ${v.border}`,
        background: v.background,
        color: v.color,
        boxShadow: variant === "secondary" ? SHADOW_SOFT : undefined,
        fontFamily: SANS,
        fontSize: size,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Text whose identifiers never break at their hyphens: words wrap only at spaces. */
export function Prose({ text }: { text: string }) {
  const parts = text.split(" ");
  return (
    <>
      {parts.map((w, i) => (
        <Fragment key={i}>
          <span style={{ whiteSpace: "nowrap" }}>{w}</span>
          {i < parts.length - 1 ? " " : ""}
        </Fragment>
      ))}
    </>
  );
}
