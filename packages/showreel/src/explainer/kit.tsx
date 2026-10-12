// Shared pieces of the Explainer scenes: the scene shell (white page, the landing's grid, a soft
// cross-fade in), the section kicker, label pills, and ClipShot — a recording of the real dashboard in
// the landing's BrowserFrame with the v2 pointer replaying the recording's own interaction log.
import type { CSSProperties, ReactNode } from "react";
import { Freeze, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { BrowserFrame } from "@web/ui";
import { Frame } from "../components/Frame";
import { C, CAMERA, IN, MONO, OUT, SANS, SHADOW_FILM, display, mix, p } from "../theme";
import { arc, reach } from "../v2/camera";
import type { ClipEvent } from "./schema";
import { warp, type Shot } from "./plan";
import { A, OVERLAP } from "./timeline";

export const W = 1920;
export const H = 1080;

/** White page + grid; fades in over the previous scene (which keeps drawing for OVERLAP frames). */
export function SceneShell({ children, dur, fadeIn = true, bg = C.page }: { children: ReactNode; dur: number; fadeIn?: boolean; bg?: string }) {
  const frame = useCurrentFrame();
  const a = fadeIn ? p(frame, 0, OVERLAP, OUT) : 1;
  const out = p(frame, dur, OVERLAP, IN);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: a, background: bg, overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${mix(a, 1.015, 1) * mix(out, 1, 0.99)})` }}>
        <Frame color={C.hairline} node={C.hairline} fill={C.page} opacity={0.9} />
        {children}
      </div>
    </div>
  );
}

/** Section kicker: number + name, top-left on the grid's safe line. */
export function Kicker({ n, label, at = 0, color = C.muted }: { n: string; label: string; at?: number; color?: string }) {
  const frame = useCurrentFrame();
  const t = p(frame, at, 14);
  return (
    <div style={{ position: "absolute", left: 120, top: 46, display: "flex", alignItems: "center", gap: 14, opacity: t, transform: `translateY(${(1 - t) * 10}px)`, fontFamily: SANS, fontSize: 21, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color }}>
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 999, background: C.accentSoft, color: C.accentText, fontSize: 15, letterSpacing: 0 }}>{n}</span>
      {label}
    </div>
  );
}

export type Tone = "neutral" | "safe" | "unsafe" | "held" | "accent";
const TONES: Record<Tone, { bg: string; fg: string; line: string }> = {
  neutral: { bg: C.mutedSurface, fg: C.strongMuted, line: C.hairline },
  safe: { bg: C.certifiedBg, fg: C.certifiedText, line: "#BBF7D0" },
  unsafe: { bg: C.unsafeBg, fg: C.unsafeText, line: "#FECACA" },
  held: { bg: C.heldBg, fg: C.heldText, line: "#FDE2B3" },
  accent: { bg: C.accentSoft, fg: C.accentText, line: "#C9DAFB" },
};

export function Pill({ tone = "neutral", children, size = 18, style }: { tone?: Tone; children: ReactNode; size?: number; style?: CSSProperties }) {
  const t = TONES[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: `${size * 0.28}px ${size * 0.7}px`, borderRadius: 999, background: t.bg, color: t.fg, border: `1px solid ${t.line}`, fontFamily: SANS, fontSize: size, fontWeight: 600, lineHeight: 1.2, whiteSpace: "nowrap", ...style }}>
      {children}
    </span>
  );
}

/** A floating card (film shadow, card radius). */
export function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: C.page, border: `1px solid ${C.hairline}`, borderRadius: 20, boxShadow: SHADOW_FILM, ...style }}>{children}</div>;
}

/** Rise + fade between two frames (relative). */
export function Reveal({ at, until, children, style, rise = 24 }: { at: number; until?: number; children: ReactNode; style?: CSSProperties; rise?: number }) {
  const frame = useCurrentFrame();
  const a = p(frame, at, 14);
  const b = until !== undefined ? p(frame, until, 10, IN) : 0;
  if (a <= 0 || b >= 1) return null;
  return <div style={{ opacity: a * (1 - b), transform: `translateY(${(1 - a) * rise - b * 16}px)`, ...style }}>{children}</div>;
}

export const Title = ({ children, size = 64, style }: { children: ReactNode; size?: number; style?: CSSProperties }) => <div style={{ ...display, fontSize: size, color: C.text, ...style }}>{children}</div>;
export const Mono = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => <span style={{ fontFamily: MONO, ...style }}>{children}</span>;

// ------------------------------------------------------------------------------- the pointer

/** Pointer position at clip time t from the recording's logged events (eased moves between them). */
export function pointerFromEvents(events: readonly ClipEvent[], t: number): { x: number; y: number; visible: number } {
  if (!events.length) return { x: 0, y: 0, visible: 0 };
  const first = events[0]!;
  if (t < first.tSec - 0.6) return { x: first.x, y: first.y, visible: 0 };
  let prev = first;
  for (const e of events) {
    if (e.tSec <= t) {
      prev = e;
      continue;
    }
    const span = Math.min(0.7, Math.max(0.15, e.tSec - prev.tSec));
    const start = e.tSec - span;
    if (t <= start) return { x: prev.x, y: prev.y, visible: 1 };
    const k = reach((t - start) / span);
    return { ...arc(prev, e, k, 0.12), visible: 1 };
  }
  return { x: prev.x, y: prev.y, visible: 1 };
}

function Pointer({ x, y, press }: { x: number; y: number; press: number }) {
  return (
    <svg width={38} height={50} viewBox="0 0 19 25" style={{ position: "absolute", left: x - 2, top: y - 2, transform: `scale(${1 - 0.14 * press})`, transformOrigin: "2px 2px", filter: "drop-shadow(0 3px 5px rgb(11 15 25 / 0.28)) drop-shadow(0 1px 1px rgb(11 15 25 / 0.2))" }} aria-hidden="true">
      <path d="M1.5 1.2v19.6l4.7-4.6 3.1 7.2 3.2-1.4-3.1-7.1h6.6z" fill="#0B0F19" stroke="#FFFFFF" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

// ------------------------------------------------------------------------------- ClipShot

export type Zoom = { at: number; s: number; x: number; y: number }[];

/**
 * A recorded clip in the BrowserFrame, playing from `from` to `to` (frames relative to the scene).
 * Missing clip → `fallback` (the same records rendered from data). `zoom` keys are in clip pixels;
 * "auto" pushes in on the recording's clicks.
 */
export function ClipShot({
  shot,
  fallback,
  tag,
  address,
  zoom = "auto",
  overlay,
  frameStyle,
  width = 1440,
}: {
  shot: Shot;
  fallback: ReactNode;
  tag?: string;
  address?: string;
  zoom?: "auto" | "none" | Zoom;
  overlay?: ReactNode;
  frameStyle?: CSSProperties;
  width?: number;
}) {
  const frame = useCurrentFrame();
  const { clipId, from, to } = shot;
  const clip = A.clips[clipId];
  if (frame < from || frame >= to) return null;
  const local = frame - from;
  const slot = to - from;
  const enter = p(frame, from, 16, OUT);
  const real = clip && clip.status === "real" && clip.src;
  const bodyW = 1280;
  const bodyH = 720;
  const scale = width / bodyW;
  let inner: ReactNode;
  if (real) {
    const w = warp(clip.durationSec, shot);
    const t = w.tAt(frame);
    const sx = bodyW / (clip.width || 1920);
    const sy = bodyH / (clip.height || 1080);
    // Camera inside the page: keys in clip pixels.
    const clicks = clip.events.filter((e) => e.type === "click");
    const keys: Zoom =
      zoom === "none"
        ? [{ at: 0, s: 1, x: clip.width / 2, y: clip.height / 2 }]
        : zoom === "auto"
          ? autoZoom(clip, shot, (t) => (w.frameAt(t) ?? to) - from, slot)
          : zoom;
    const cam = camAt(keys, local);
    // Keep the page edges out of view while zoomed.
    const cx = clamp(cam.x * sx, bodyW / 2 / cam.s, bodyW - bodyW / 2 / cam.s);
    const cy = clamp(cam.y * sy, bodyH / 2 / cam.s, bodyH - bodyH / 2 / cam.s);
    const ptr = pointerFromEvents(clip.events, t);
    const press = clicks.reduce((m, c) => {
      const d = (t - c.tSec) * 30;
      return Math.max(m, d >= -3 && d <= 0 ? (d + 3) / 3 : d > 0 && d <= 4 ? 1 - d / 4 : 0);
    }, 0);
    inner = (
      <div style={{ position: "absolute", inset: 0, transformOrigin: "0 0", transform: `translate(${bodyW / 2}px, ${bodyH / 2}px) scale(${cam.s}) translate(${-cx}px, ${-cy}px)` }}>
        <Sequence from={from} durationInFrames={slot} layout="none">
          <Freeze frame={Math.round(t * 30)}>
            <OffthreadVideo src={staticFile(clip.src!)} muted style={{ position: "absolute", left: 0, top: 0, width: bodyW, height: bodyH }} />
          </Freeze>
        </Sequence>
        {clicks.map((c) => {
          const d = (t - c.tSec) * 30;
          if (d < 0 || d > 16) return null;
          const k = d / 16;
          const r = (10 + 40 * (1 - (1 - k) * (1 - k))) / cam.s;
          return <div key={c.tSec} style={{ position: "absolute", left: c.x * sx - r, top: c.y * sy - r, width: r * 2, height: r * 2, borderRadius: "50%", background: `rgb(47 106 235 / ${0.22 * (1 - k)})`, boxShadow: `0 0 0 2px rgb(47 106 235 / ${0.35 * (1 - k)})` }} />;
        })}
        {ptr.visible > 0 && (
          <div style={{ position: "absolute", left: 0, top: 0, opacity: ptr.visible, transform: `scale(${1 / cam.s})`, transformOrigin: `${ptr.x * sx}px ${ptr.y * sy}px` }}>
            <Pointer x={ptr.x * sx} y={ptr.y * sy} press={press} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={{ position: "absolute", left: (W - width) / 2, top: 112, width, opacity: enter * (1 - p(frame, to - OVERLAP / 2, OVERLAP / 2, IN) * 0), transform: `translateY(${(1 - enter) * 40}px)`, ...frameStyle }}>
      {real ? (
        <div style={{ width: bodyW, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
          <BrowserFrame address={address ?? clip.url?.replace(/^https?:\/\//, "") ?? undefined} tag={tag}>
            <div style={{ position: "relative", width: bodyW, height: bodyH, overflow: "hidden", background: C.page }}>{inner}</div>
          </BrowserFrame>
        </div>
      ) : (
        fallback
      )}
      {overlay}
    </div>
  );
}

/**
 * The camera follows what the recording points at: a push-in on each labelled event of the log (the
 * recording agent labels the moves that land on something: "run id", "observed", …) and on clicks;
 * without any, a slow 6% push.
 */
function autoZoom(clip: { width: number; height: number; events: ClipEvent[] }, shot: Shot, frameOf: (t: number) => number, slot: number): Zoom {
  if (shot.zoom) return shot.zoom;
  const c = { x: clip.width / 2, y: clip.height / 2 };
  const marks = clip.events.filter((e) => (e.type === "click" || (e.type === "move" && e.label)) && e.label !== "start");
  if (!marks.length) return [{ at: 0, s: 1, ...c }, { at: slot, s: 1.06, ...c }];
  const keys: Zoom = [{ at: 0, s: 1, ...c }];
  for (const m of marks) {
    const at = Math.max(keys.at(-1)!.at + 8, frameOf(m.tSec) - 10);
    if (at >= slot) break;
    keys.push({ at, s: 1.3, x: m.x, y: m.y });
  }
  keys.push({ at: Math.max(keys.at(-1)!.at + 1, slot), s: keys.at(-1)!.s, x: keys.at(-1)!.x, y: keys.at(-1)!.y });
  return keys;
}

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

function camAt(keys: Zoom, f: number) {
  if (f <= keys[0]!.at) return keys[0]!;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (f <= b.at) {
      const t = CAMERA(Math.min(1, (f - a.at) / Math.max(1, b.at - a.at)));
      return { at: f, s: mix(t, a.s, b.s), x: mix(t, a.x, b.x), y: mix(t, a.y, b.y) };
    }
  }
  return keys.at(-1)!;
}
