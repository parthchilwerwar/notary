// Shared pieces of the Explainer scenes: the scene shell (zoom-through transitions and the numbered
// title card that docks into the section kicker), the 8-part progress bar, kinetic type driven by the
// voice's word timings, label pills, drawn-in callouts, and ClipShot — a recording of the real
// dashboard in the landing's BrowserFrame, with the camera following the recording's logged targets,
// the pointer replaying its interaction log (eased moves, hover lift, press, ripple, focus lens).
import type { CSSProperties, ReactNode } from "react";
import { Freeze, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { BrowserFrame } from "@web/ui";
import { Frame } from "../components/Frame";
import { C, CAMERA, IN, LINE, MONO, OUT, SANS, SHADOW_FILM, display, mix, p } from "../theme";
import { arc, reach } from "../v2/camera";
import type { ClipEvent, SectionId } from "./schema";
import { warp, type Shot } from "./plan";
import { A, OVERLAP, phraseWords, SECTIONS } from "./timeline";

export const W = 1920;
export const H = 1080;

export const SECTION_TITLES: Record<SectionId, string> = {
  intro: "Notary",
  problem: "The problem",
  notary: "What Notary does",
  stack: "The stack",
  neatlogs: "neatlogs",
  entire: "Entire",
  cfo: "cfo.ai",
  close: "What Notary proved",
};
export const sectionNumber = (id: SectionId) => String(SECTIONS.findIndex((s) => s.id === id) + 1).padStart(2, "0");

// ------------------------------------------------------------------------------- scene shell

/** Frames of the title card: in, hold, dock into the kicker. Scene content arrives under it. */
export const CARD = { in: 12, dock: 22, docked: 34, content: 20 } as const;

/**
 * White page + grid. Zooms through: the scene arrives from slightly larger as it fades in over the
 * previous one (which keeps drawing for OVERLAP frames and recedes). Opens on its title card.
 */
export function SceneShell({ id, children, dur, bg = C.page, card = true }: { id: SectionId; children: ReactNode; dur: number; bg?: string; card?: boolean }) {
  const frame = useCurrentFrame();
  const a = p(frame, 0, OVERLAP + 4, OUT);
  const out = p(frame, dur, OVERLAP, IN);
  const content = card ? p(frame, CARD.content, 16, OUT) : 1;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: a, background: bg, overflow: "hidden", transform: `scale(${mix(a, 1.07, 1) * mix(out, 1, 0.93)})`, transformOrigin: "50% 45%" }}>
      <Frame color={C.hairline} node={C.hairline} fill={C.page} opacity={0.9} />
      <div style={{ position: "absolute", inset: 0, opacity: content, transform: `translateY(${(1 - content) * 28}px) scale(${mix(content, 0.985, 1)})` }}>{children}</div>
      {card && <TitleCard id={id} />}
    </div>
  );
}

/** "03 · The stack": rises in large, then shrinks and flies into the kicker at the top left. */
function TitleCard({ id }: { id: SectionId }) {
  const frame = useCurrentFrame();
  const n = sectionNumber(id);
  const title = SECTION_TITLES[id];
  const enter = p(frame, 0, CARD.in, OUT);
  const dock = p(frame, CARD.dock, CARD.docked - CARD.dock, CAMERA);
  const kicker = p(frame, CARD.docked - 6, 8);
  const words = title.split(" ");
  return (
    <>
      {dock < 1 && (
        <div
          style={{
            position: "absolute",
            left: mix(dock, 160, 120),
            top: mix(dock, 360, 30),
            transformOrigin: "0 0",
            transform: `scale(${mix(dock, 1, 0.2)})`,
            opacity: 1 - p(frame, CARD.docked - 6, 6),
            display: "flex",
            alignItems: "baseline",
            gap: 36,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ ...display, fontSize: 230, color: C.accent, opacity: enter, transform: `translateX(${(1 - enter) * -60}px)`, display: "inline-block" }}>{n}</span>
          <span style={{ width: 4, height: 150, background: C.hairline, transform: `scaleY(${enter})`, alignSelf: "center" }} />
          <span style={{ ...display, fontSize: 130, color: C.text }}>
            {words.map((w, i) => {
              const t = p(frame, 2 + i * 2, CARD.in);
              return (
                <span key={i} style={{ display: "inline-block", opacity: t, transform: `translateY(${(1 - t) * 40}px)`, marginRight: i < words.length - 1 ? 28 : 0 }}>
                  {w}
                </span>
              );
            })}
          </span>
        </div>
      )}
      {kicker > 0 && <Kicker n={n} label={title} opacity={kicker} />}
    </>
  );
}

/** Section kicker: number + name, top-left on the grid's safe line. */
export function Kicker({ n, label, opacity = 1, color = C.muted }: { n: string; label: string; opacity?: number; color?: string }) {
  return (
    <div style={{ position: "absolute", left: 120, top: 46, display: "flex", alignItems: "center", gap: 14, opacity, fontFamily: SANS, fontSize: 21, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color }}>
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 40, height: 34, padding: "0 8px", borderRadius: 999, background: C.accentSoft, color: C.accentText, fontSize: 15, letterSpacing: "0.02em" }}>{n}</span>
      {label}
    </div>
  );
}

/** The 8-part progress line along the top edge: past parts settled, the current one filling. */
export function ProgressBar({ frame, onSky }: { frame: number; onSky: boolean }) {
  const gap = 10;
  const x0 = 120;
  const w = (1680 - gap * (SECTIONS.length - 1)) / SECTIONS.length;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: 20, pointerEvents: "none" }}>
      {SECTIONS.map((s, i) => {
        const t = Math.max(0, Math.min(1, (frame - s.from) / s.dur));
        const cur = frame >= s.from && frame < s.from + s.dur;
        return (
          <div key={s.id} style={{ position: "absolute", left: x0 + i * (w + gap), top: 12, width: w, height: 4, borderRadius: 2, background: onSky ? "rgb(255 255 255 / 0.25)" : C.hairline, overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 0, transformOrigin: "0 50%", transform: `scaleX(${t})`, background: cur ? (onSky ? "#FFFFFF" : C.accent) : onSky ? "rgb(255 255 255 / 0.6)" : C.strongMuted, opacity: cur ? 1 : 0.55 }} />
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------- type

/**
 * A phrase that builds word by word exactly as the voice says it. Emphasis words come in accent,
 * italic, with a small scale pop on their word.
 */
export function Kinetic({ id, phrase, size, emphasis = [], at = 0, color = C.text, style, lineBreakAfter = [] }: { id: SectionId; phrase: string; size: number; emphasis?: string[]; at?: number; color?: string; style?: CSSProperties; lineBreakAfter?: number[] }) {
  const frame = useCurrentFrame();
  const words = phraseWords(id, phrase, at);
  const emph = new Set(emphasis.map((e) => e.toLowerCase()));
  return (
    <div style={{ ...display, fontSize: size, color, ...style }}>
      {words.map((w, i) => {
        const t = p(frame, w.from - 4, 12);
        const key = w.text.toLowerCase().replace(/[^\p{L}\p{N}$.]/gu, "").replace(/\.$/, "");
        const isEm = emph.has(key);
        const pop = isEm ? Math.sin(Math.PI * p(frame, w.from - 2, 14, LINE)) : 0;
        return (
          <span key={i}>
            <span style={{ display: "inline-block", opacity: t, transform: `translateY(${(1 - t) * size * 0.35}px) scale(${1 + pop * 0.08})`, transformOrigin: "50% 80%", color: isEm ? C.accentText : undefined, fontStyle: isEm ? "italic" : undefined, marginRight: size * 0.22 }}>
              {w.text}
            </span>
            {lineBreakAfter.includes(i) && <br />}
          </span>
        );
      })}
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
export function Reveal({ at, until, children, style, rise = 24, from = "below" }: { at: number; until?: number; children: ReactNode; style?: CSSProperties; rise?: number; from?: "below" | "left" | "right" }) {
  const frame = useCurrentFrame();
  const a = p(frame, at, 14);
  const b = until !== undefined ? p(frame, until, 10, IN) : 0;
  if (a <= 0 || b >= 1) return null;
  const d = (1 - a) * rise;
  const tr = from === "below" ? `translateY(${d - b * 16}px)` : `translateX(${from === "left" ? -d : d}px) translateY(${-b * 16}px)`;
  return <div style={{ opacity: a * (1 - b), transform: `${tr} scale(${mix(a, 0.97, 1)})`, ...style }}>{children}</div>;
}

export const Title = ({ children, size = 64, style }: { children: ReactNode; size?: number; style?: CSSProperties }) => <div style={{ ...display, fontSize: size, color: C.text, ...style }}>{children}</div>;
export const Mono = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => <span style={{ fontFamily: MONO, ...style }}>{children}</span>;

// ------------------------------------------------------------------------------- callouts

/**
 * A callout that draws in: a ring around the target, a curved stroke to the label (stroke-dashoffset),
 * then the label. Coordinates are in the parent's pixels; `at` / `until` are frames.
 */
export function DrawCallout({ x, y, dx, dy, text, at, until, frame }: { x: number; y: number; dx: number; dy: number; text: string; at: number; until: number; frame: number }) {
  const draw = p(frame, at, 14, LINE);
  const label = p(frame, at + 8, 12);
  const out = p(frame, until - 8, 8, IN);
  if (draw <= 0 || out >= 1) return null;
  const lx = x + dx;
  const ly = y + dy;
  const cx = x + dx * 0.55;
  const cy = y + dy * 0.1;
  const r = 30;
  const ang = Math.atan2(cy - y, cx - x);
  const sx = x + Math.cos(ang) * r;
  const sy = y + Math.sin(ang) * r;
  const path = `M ${sx} ${sy} Q ${cx} ${cy} ${lx} ${ly}`;
  const len = Math.hypot(cx - sx, cy - sy) + Math.hypot(lx - cx, ly - cy);
  const ring = 2 * Math.PI * r;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - out, pointerEvents: "none" }}>
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }} aria-hidden="true">
        <circle cx={x} cy={y} r={r} fill="rgb(47 106 235 / 0.08)" stroke={C.accent} strokeWidth={3} strokeDasharray={ring} strokeDashoffset={ring * (1 - Math.min(1, draw * 1.6))} transform={`rotate(-90 ${x} ${y})`} />
        <path d={path} fill="none" stroke={C.accent} strokeWidth={3} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
      </svg>
      <div style={{ position: "absolute", left: lx, top: ly, transform: `translate(${dx < 0 ? "-100%" : "0"}, -50%) translateX(${dx < 0 ? -10 : 10}px) scale(${mix(label, 0.9, 1)})`, transformOrigin: dx < 0 ? "100% 50%" : "0 50%", opacity: label }}>
        <span style={{ display: "inline-block", padding: "8px 16px", borderRadius: 12, background: C.accent, color: "#FFFFFF", fontFamily: SANS, fontSize: 22, fontWeight: 600, whiteSpace: "nowrap", boxShadow: "0 10px 30px rgb(47 106 235 / 0.35)" }}>{text}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------- the pointer

/** Pointer position at clip time t from the recording's logged events (eased moves between them). */
export function pointerFromEvents(events: readonly ClipEvent[], t: number): { x: number; y: number; visible: number; lift: number } {
  if (!events.length) return { x: 0, y: 0, visible: 0, lift: 0 };
  const first = events[0]!;
  if (t < first.tSec - 0.6) return { x: first.x, y: first.y, visible: 0, lift: 0 };
  let prev = first;
  for (const e of events) {
    if (e.tSec <= t) {
      prev = e;
      continue;
    }
    const span = Math.min(0.75, Math.max(0.18, e.tSec - prev.tSec));
    const start = e.tSec - span;
    if (t <= start) return { x: prev.x, y: prev.y, visible: 1, lift: hoverLift(prev, t) };
    const k = reach((t - start) / span);
    return { ...arc(prev, e, k, 0.14), visible: 1, lift: 0 };
  }
  return { x: prev.x, y: prev.y, visible: 1, lift: hoverLift(prev, t) };
}

/** Resting on a labelled target: a short lift (0 → 1 → settles at 0.4). */
function hoverLift(e: ClipEvent, t: number) {
  if (!(e.type === "move" && e.label && e.label !== "start")) return 0;
  const d = t - e.tSec;
  return d < 0 ? 0 : d < 0.15 ? d / 0.15 : Math.max(0.4, 1 - (d - 0.15) / 0.5);
}

function Pointer({ x, y, press, lift }: { x: number; y: number; press: number; lift: number }) {
  return (
    <svg
      width={38}
      height={50}
      viewBox="0 0 19 25"
      style={{
        position: "absolute",
        left: x - 2,
        top: y - 2,
        transform: `translate(${-lift * 2}px, ${-lift * 3}px) scale(${(1 + 0.1 * lift) * (1 - 0.14 * press)})`,
        transformOrigin: "2px 2px",
        filter: `drop-shadow(0 ${3 + lift * 5}px ${5 + lift * 6}px rgb(11 15 25 / ${0.28 + lift * 0.08})) drop-shadow(0 1px 1px rgb(11 15 25 / 0.2))`,
      }}
      aria-hidden="true"
    >
      <path d="M1.5 1.2v19.6l4.7-4.6 3.1 7.2 3.2-1.4-3.1-7.1h6.6z" fill="#0B0F19" stroke="#FFFFFF" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

// ------------------------------------------------------------------------------- ClipShot

export type Zoom = { at: number; s: number; x: number; y: number }[];
const BODY_W = 1280;
const BODY_H = 720;

/**
 * A recorded clip in the BrowserFrame for its shot (frames relative to the scene). Missing clip →
 * `fallback` (the same records rendered from data). The camera follows the logged targets unless the
 * shot gives its own zoom keys.
 */
export function ClipShot({ shot, fallback, tag, overlay, frameStyle, width = 1440 }: { shot: Shot; fallback: ReactNode; tag?: string; overlay?: ReactNode; frameStyle?: CSSProperties; width?: number }) {
  const frame = useCurrentFrame();
  const { clipId, from, to } = shot;
  const clip = A.clips[clipId];
  if (frame < from || frame >= to) return null;
  const local = frame - from;
  const slot = to - from;
  const enter = p(frame, from, 18, OUT);
  const real = clip && clip.status === "real" && clip.src;
  const scale = width / BODY_W;
  let inner: ReactNode = null;
  let overlays: ReactNode = null;
  if (real) {
    const w = warp(clip.durationSec, shot);
    const t = w.tAt(frame);
    const sx = BODY_W / (clip.width || 1920);
    const sy = BODY_H / (clip.height || 1080);
    const keys = autoZoom(clip, shot, (tt) => (w.frameAt(tt) ?? to) - from, slot);
    const cam = camAt(keys, local);
    const cx = clamp(cam.x * sx, BODY_W / 2 / cam.s, BODY_W - BODY_W / 2 / cam.s);
    const cy = clamp(cam.y * sy, BODY_H / 2 / cam.s, BODY_H - BODY_H / 2 / cam.s);
    // Clip pixels → body pixels on screen (after the camera).
    const toBody = (x: number, y: number) => ({ x: (x * sx - cx) * cam.s + BODY_W / 2, y: (y * sy - cy) * cam.s + BODY_H / 2 });
    const clicks = clip.events.filter((e) => e.type === "click");
    const ptr = pointerFromEvents(clip.events, t);
    const press = clicks.reduce((m, c) => {
      const d = (t - c.tSec) * 30;
      return Math.max(m, d >= -3 && d <= 0 ? (d + 3) / 3 : d > 0 && d <= 4 ? 1 - d / 4 : 0);
    }, 0);
    const layer = (extra: string, src = clip.src!) => (
      <div style={{ position: "absolute", left: 0, top: 0, width: BODY_W, height: BODY_H, transformOrigin: "0 0", transform: `${extra} translate(${BODY_W / 2}px, ${BODY_H / 2}px) scale(${cam.s}) translate(${-cx}px, ${-cy}px)` }}>
        <Sequence from={from} durationInFrames={slot} layout="none">
          <Freeze frame={Math.round(t * 30)}>
            <OffthreadVideo src={staticFile(src)} muted style={{ position: "absolute", left: 0, top: 0, width: BODY_W, height: BODY_H }} />
          </Freeze>
        </Sequence>
      </div>
    );
    inner = layer("");
    // Focus lens: a soft magnifier on each click target for ~0.9 s.
    const lensClick = shot.lens ? clicks.find((c) => t >= c.tSec - 0.05 && t <= c.tSec + 0.9) : undefined;
    const lens = lensClick ? (() => {
      const k = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - lensClick.tSec + 0.05) / 0.95)));
      const c = toBody(lensClick.x, lensClick.y);
      const R = 92 * k;
      const m = 1.7;
      return R > 2 ? (
        <div style={{ position: "absolute", left: c.x - R, top: c.y - R, width: R * 2, height: R * 2, borderRadius: "50%", overflow: "hidden", boxShadow: `0 0 0 3px ${C.accent}, 0 18px 40px rgb(11 15 25 / 0.25)`, background: C.page }}>
          <div style={{ position: "absolute", left: -(c.x - R), top: -(c.y - R), width: BODY_W, height: BODY_H, transformOrigin: `${c.x}px ${c.y}px`, transform: `scale(${m})` }}>{layer("", clip.src!.replace(/.mp4$/, ".lens.mp4"))}</div>
        </div>
      ) : null;
    })() : null;
    const ripples = clicks.map((c) => {
      const d = (t - c.tSec) * 30;
      if (d < 0 || d > 18) return null;
      const k = d / 18;
      const r = 12 + 48 * (1 - (1 - k) * (1 - k));
      const b = toBody(c.x, c.y);
      return <div key={c.tSec} style={{ position: "absolute", left: b.x - r, top: b.y - r, width: r * 2, height: r * 2, borderRadius: "50%", background: `rgb(47 106 235 / ${0.2 * (1 - k)})`, boxShadow: `0 0 0 2.5px rgb(47 106 235 / ${0.45 * (1 - k)})` }} />;
    });
    const callouts = (shot.callouts ?? []).map((co, i, all) => {
      const e = clip.events.find((x) => x.label?.includes(co.label));
      if (!e || !co.text) return null;
      const at = (w.frameAt(e.tSec) ?? to) - 2;
      const nextE = all[i + 1] ? clip.events.find((x) => x.label?.includes(all[i + 1]!.label)) : undefined;
      const nextAt = nextE ? (w.frameAt(nextE.tSec) ?? to) - 4 : to;
      const until = Math.min(at + (co.hold ?? 120), nextAt, to - 2);
      const b = toBody(e.x, e.y);
      return <DrawCallout key={co.label} frame={frame} x={b.x} y={b.y} dx={co.dx} dy={co.dy} text={co.text} at={at} until={until} />;
    });
    const pb = toBody(ptr.x, ptr.y);
    overlays = (
      <>
        {ripples}
        {lens}
        {callouts}
        {ptr.visible > 0 && <Pointer x={pb.x} y={pb.y} press={press} lift={ptr.lift} />}
      </>
    );
  }
  return (
    <div style={{ position: "absolute", left: (W - width) / 2, top: 112, width, opacity: enter, transform: `translateY(${(1 - enter) * 50}px) scale(${mix(enter, 0.96, 1)})`, transformOrigin: "50% 0", ...frameStyle }}>
      {real ? (
        <div style={{ width: BODY_W, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
          <BrowserFrame address={clip.url ? `127.0.0.1:5173${clip.url.replace(/^https?:\/\/[^/]+/, "")}` : undefined} tag={tag}>
            <div style={{ position: "relative", width: BODY_W, height: BODY_H, overflow: "hidden", background: C.page }}>
              {inner}
              {overlays}
            </div>
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
 * The camera follows what the recording points at: a push-in on each labelled event of the log and
 * on clicks; without any, a slow 6% push.
 */
function autoZoom(clip: { width: number; height: number; events: ClipEvent[] }, shot: Shot, frameOf: (t: number) => number, slot: number): Zoom {
  if (shot.zoom) return shot.zoom;
  const c = { x: clip.width / 2, y: clip.height / 2 };
  const marks = clip.events.filter((e) => (e.type === "click" || (e.type === "move" && e.label)) && e.label !== "start");
  if (!marks.length) return [{ at: 0, s: 1, ...c }, { at: slot, s: 1.06, ...c }];
  const keys: Zoom = [{ at: 0, s: 1.04, ...c }];
  for (const m of marks) {
    const at = Math.max(keys.at(-1)!.at + 10, frameOf(m.tSec) - 12);
    if (at >= slot) break;
    keys.push({ at, s: 1.32, x: m.x, y: m.y });
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
