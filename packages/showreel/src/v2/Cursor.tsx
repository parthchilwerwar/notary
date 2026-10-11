// A macOS-style pointer (SVG, crisp at any scale, soft shadow) and its click ripple. Position,
// press and ripples are computed by the caller from the frame; nothing here keeps time.
import { arc, reach } from "./camera";

export type Pt = { x: number; y: number };
/** One move: leave at `from`, arrive at `at` on `to` (a function: targets can move with the camera). */
export type Move = { from: number; at: number; to: (frame: number) => Pt; bend?: number };
export type Click = { at: number };

export function pointerAt(frame: number, start: Pt, moves: readonly Move[]): Pt {
  let pos = start;
  for (const m of moves) {
    if (frame < m.from) return pos;
    const dest = m.to(frame);
    if (frame >= m.at) {
      pos = dest;
      continue;
    }
    const origin = pos;
    const t = reach((frame - m.from) / (m.at - m.from));
    return arc(origin, dest, t, m.bend ?? 0.16);
  }
  return pos;
}

/** 0 → 1 → 0 around a click (press for 3 frames, release over 4). */
export function pressAt(frame: number, clicks: readonly Click[]): number {
  for (const c of clicks) {
    const d = frame - c.at;
    if (d >= -3 && d <= 0) return (d + 3) / 3;
    if (d > 0 && d <= 4) return 1 - d / 4;
  }
  return 0;
}

export function Cursor({ x, y, press, opacity, clicks, frame }: { x: number; y: number; press: number; opacity: number; clicks: readonly (Click & Pt)[]; frame: number }) {
  return (
    <>
      {clicks.map((c) => {
        const d = frame - c.at;
        if (d < 0 || d > 16) return null;
        const t = d / 16;
        const r = 10 + 46 * (1 - (1 - t) * (1 - t));
        return (
          <div
            key={c.at}
            style={{
              position: "absolute",
              left: c.x - r,
              top: c.y - r,
              width: r * 2,
              height: r * 2,
              borderRadius: "50%",
              background: `rgb(47 106 235 / ${0.22 * (1 - t)})`,
              boxShadow: `0 0 0 2px rgb(47 106 235 / ${0.35 * (1 - t)})`,
              pointerEvents: "none",
            }}
          />
        );
      })}
      <svg
        width={38}
        height={50}
        viewBox="0 0 19 25"
        style={{
          position: "absolute",
          left: x - 2,
          top: y - 2,
          opacity,
          transform: `scale(${1 - 0.14 * press})`,
          transformOrigin: "2px 2px",
          filter: "drop-shadow(0 3px 5px rgb(11 15 25 / 0.28)) drop-shadow(0 1px 1px rgb(11 15 25 / 0.2))",
          pointerEvents: "none",
        }}
        aria-hidden="true"
      >
        <path d="M1.5 1.2v19.6l4.7-4.6 3.1 7.2 3.2-1.4-3.1-7.1h6.6z" fill="#0B0F19" stroke="#FFFFFF" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </>
  );
}
