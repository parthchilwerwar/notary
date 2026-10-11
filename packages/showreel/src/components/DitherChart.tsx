// Money actions by request type (the landing's ActionsChart), drawn per frame on a canvas with the
// shared ordered dither (packages/web/src/components/brand/dither.ts: Bayer 8×8, 3 px cells on one
// absolute grid, a cell is on when intensity > (bayer + 0.5) / 64). Allowed = executed − graded
// unsafe (accent), Unsafe = graded unsafe (red dither), Held for review (amber dither); dithers fade
// from 1.0 at the base to 0.35 at the top. One column per request type morphs from the agent
// without Notary to Notary:
//   grow     the naive stacks rise (rows revealed bottom-up)
//   dissolve what Notary does not execute dissolves top-down through the dither threshold
//   rise     Notary's held (and allowed) stacks rise in their place
import { useLayoutEffect, useRef } from "react";
import type { ShowreelData } from "../data-schema";
import { C, SANS } from "../theme";

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
] as const;
const on = (x: number, y: number, intensity: number) => intensity > (BAYER8[((y % 8) + 8) % 8]![((x % 8) + 8) % 8]! + 0.5) / 64;

const CELL = 3;
type Row = ShowreelData["chart"]["rows"][number];
type Counts = Row["naive"];
type Seg = { kind: "allowed" | "unsafe" | "held"; n: number };

const COLORS = { allowed: C.accent, unsafe: C.unsafe, held: C.held } as const;
const parts = (c: Counts): Seg[] => [
  { kind: "allowed", n: c.executed - c.unsafe },
  { kind: "unsafe", n: c.unsafe },
  { kind: "held", n: c.held },
];
export const total = (c: Counts) => c.executed + c.held;

export function niceTicks(max: number): number[] {
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : 10 ** Math.floor(Math.log10(max));
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

/**
 * Paint a rect cell by cell. `intensity(cellRowCenterY)` → 0–1 (before the dither test); solid
 * fills pass a constant 1 (every cell on) and still dissolve through the same threshold.
 */
function paint(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, intensity: (py: number) => number) {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  const left = Math.round(x);
  const right = Math.round(x + w);
  const top = Math.round(y);
  const bottom = Math.round(y + h);
  for (let cy = Math.floor(top / CELL); cy < Math.ceil(bottom / CELL); cy++) {
    const py0 = Math.max(top, cy * CELL);
    const py1 = Math.min(bottom, (cy + 1) * CELL);
    if (py1 <= py0) continue;
    const k = intensity((py0 + py1) / 2);
    if (k <= 0) continue;
    for (let cx = Math.floor(left / CELL); cx < Math.ceil(right / CELL); cx++) {
      if (!on(cx, cy, k)) continue;
      const px0 = Math.max(left, cx * CELL);
      const px1 = Math.min(right, (cx + 1) * CELL);
      if (px1 > px0) ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
    }
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export type ChartPhase = { grow: number; dissolve: number; rise: number };

/** Per-column progress with a small left-to-right stagger. */
const stagger = (t: number, i: number, n: number) => clamp01(t * (1 + 0.12 * (n - 1)) - 0.12 * i);

export function DitherChart({ rows, width, height, phase, fontScale = 1 }: { rows: Row[]; width: number; height: number; phase: ChartPhase; fontScale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const max = Math.max(1, ...rows.flatMap((r) => [total(r.naive), total(r.guarded)]));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const axis = 44 * fontScale; // left gutter for tick labels
  const plotW = width - axis;
  const unit = height / top;
  const groupW = plotW / rows.length;
  const colW = Math.min(120, Math.round(groupW * 0.36 / CELL) * CELL);
  const colX = (i: number) => Math.round((axis + groupW * i + (groupW - colW) / 2) / CELL) * CELL;

  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    rows.forEach((r, i) => {
      const x = colX(i);
      const g = stagger(phase.grow, i, rows.length);
      const d = stagger(phase.dissolve, i, rows.length);
      const u = stagger(phase.rise, i, rows.length);
      // Height Notary keeps of the naive stack: its executed (allowed) actions.
      const keep = Math.min(r.naive.executed - r.naive.unsafe, r.guarded.executed - r.guarded.unsafe) * unit;
      // ---- the naive stack: grows bottom-up, then dissolves top-down above `keep`.
      let y = height;
      const naiveH = total(r.naive) * unit;
      const revealTop = height - naiveH * g;
      const dissolveSpan = naiveH - keep;
      const band = 42; // px of soft dither front
      const front = height - naiveH + (dissolveSpan + band) * d; // y of the dissolve front
      for (const seg of parts(r.naive)) {
        if (seg.n <= 0) continue;
        const h = seg.n * unit;
        const gap = y < height ? 3 : 0;
        const segTop = y - h;
        const segH = h - gap;
        const dithered = seg.kind !== "allowed";
        paint(ctx, x, segTop, colW, segH, COLORS[seg.kind], (py) => {
          if (py < revealTop) return 0;
          const base = dithered ? 1 + (0.35 - 1) * clamp01((height - py) / Math.max(1, naiveH)) : 1;
          if (d <= 0 || py > height - keep) return base;
          // Above the kept part: fade through the threshold as the front passes.
          const t = clamp01((front - py) / band);
          return base * (1 - t);
        });
        y -= h;
      }
      // ---- Notary's stack above what was kept: extra allowed, then held, rising bottom-up.
      if (u > 0) {
        const gParts = parts(r.guarded);
        const extraAllowed = Math.max(0, (gParts[0]!.n * unit) - keep);
        const stack: { kind: Seg["kind"]; h: number }[] = [
          { kind: "allowed", h: extraAllowed },
          { kind: "unsafe", h: gParts[1]!.n * unit },
          { kind: "held", h: gParts[2]!.n * unit },
        ];
        const riseH = stack.reduce((n, s) => n + s.h, 0);
        const riseTop = height - keep - riseH * u;
        let y2 = height - keep;
        for (const seg of stack) {
          if (seg.h <= 0) continue;
          const gap = y2 < height ? 3 : 0;
          const segTop = y2 - seg.h;
          const dithered = seg.kind !== "allowed";
          paint(ctx, x, segTop, colW, seg.h - gap, COLORS[seg.kind], (py) => {
            if (py < riseTop) return 0;
            return dithered ? 1 + (0.35 - 1) * clamp01((height - keep - py) / Math.max(1, riseH)) : 1;
          });
          y2 -= seg.h;
        }
      }
    });
  });

  const fs = 22 * fontScale;
  return (
    <div style={{ position: "relative", width, height, fontFamily: SANS }}>
      {ticks.map((t) => (
        <div key={t} style={{ position: "absolute", left: axis, right: 0, top: height - t * unit, borderTop: `1px solid ${C.hairline}` }}>
          <span style={{ position: "absolute", left: -axis, top: -fs * 0.62, width: axis - 14, textAlign: "right", color: C.muted, fontSize: fs, fontVariantNumeric: "tabular-nums" }}>{t}</span>
        </div>
      ))}
      <canvas ref={ref} width={width} height={height} style={{ position: "absolute", inset: 0, imageRendering: "pixelated" }} />
      {rows.map((r, i) => {
        const g = stagger(phase.grow, i, rows.length);
        const d = stagger(phase.dissolve, i, rows.length);
        const u = stagger(phase.rise, i, rows.length);
        const n = total(r.naive);
        const k = Math.min(r.naive.executed - r.naive.unsafe, r.guarded.executed - r.guarded.unsafe);
        const gTot = total(r.guarded);
        // The cap value follows the visible stack height.
        const shown = u > 0 ? k + (gTot - k) * u : n - (n - k) * d;
        const value = u > 0 ? Math.round(k + (gTot - k) * u) : d > 0 ? Math.round(shown) : Math.round(n * g);
        const capH = (u > 0 ? shown : d > 0 ? shown : n * g) * unit;
        // Cap values are hidden while a stack dissolves (its in-between heights are not counts anyone
        // recorded); they count up again as Notary's stack rises.
        const visible = g > 0.02 && !(d > 0 && u === 0) && (capH > unit * 0.3 || (d === 0 && u === 0) || (u >= 1 && gTot === 0));
        return (
          <div key={r.type}>
            <span
              style={{
                position: "absolute",
                left: colX(i),
                width: colW,
                top: height - capH - fs * 1.55,
                textAlign: "center",
                color: C.strongMuted,
                fontSize: fs,
                fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
                opacity: visible ? 1 : 0,
              }}
            >
              {value}
            </span>
            <span style={{ position: "absolute", left: axis + groupW * i, width: groupW, top: height + fs * 0.7, textAlign: "center", color: C.muted, fontSize: fs, whiteSpace: "nowrap" }}>
              {r.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A legend swatch with the same pattern. */
export function Swatch({ kind, size = 20 }: { kind: Seg["kind"]; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    paint(ctx, 0, 0, size, size, COLORS[kind], (py) => (kind === "allowed" ? 1 : 1 + (0.35 - 1) * (1 - py / size)));
  });
  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size, borderRadius: 3, imageRendering: "pixelated" }} />;
}
