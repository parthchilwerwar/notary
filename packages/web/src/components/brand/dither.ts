// Ordered (Bayer 8×8) dithering on a 2D canvas — the shared renderer behind DitherCanvas and
// DitherSwatch (landing chart now; the dashboard's Report chart and KPI sparklines later).
//
// A cell is filled when intensity > (BAYER8[y % 8][x % 8] + 0.5) / 64. Cells are `cell` CSS px
// (default 3) and are snapped to whole device pixels, so the pattern stays crisp at any
// devicePixelRatio; cell coordinates are absolute on the canvas, so neighbouring shapes share one
// pattern grid. Pure functions over a CanvasRenderingContext2D; no React here.

/** The classic 8×8 Bayer threshold matrix (values 0–63). */
export const BAYER8: readonly (readonly number[])[] = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/** Whether the cell at (x, y) (cell coordinates) is on for an intensity in [0, 1]. */
export const ditherOn = (x: number, y: number, intensity: number): boolean =>
  intensity > (BAYER8[((y % 8) + 8) % 8]![((x % 8) + 8) % 8]! + 0.5) / 64;

/**
 * How a rectangle is filled.
 *   { kind: "solid", color }                       plain fill
 *   { kind: "dither", color, base = 1, top = 1 }   ordered dither; intensity fades linearly from
 *                                                  `base` (bottom edge) to `top` (top edge)
 */
export type DitherFill =
  | { kind: "solid"; color: string }
  | { kind: "dither"; color: string; base?: number; top?: number };

/** A rectangle in CSS px, origin top-left of the canvas. */
export type Rect = { x: number; y: number; w: number; h: number };

export type PaintOptions = {
  /** devicePixelRatio the canvas backing store uses. */
  dpr: number;
  /** Cell size in CSS px (default 3). */
  cell?: number;
  /**
   * Only paint the part of the rect at or below this CSS-px y (bars "growing" upward by revealing
   * rows). Default: paint everything.
   */
  revealFromY?: number;
};

/** Paint one rect. Dithered rects are drawn cell by cell on the shared absolute grid. */
export function paintRect(ctx: CanvasRenderingContext2D, rect: Rect, fill: DitherFill, opts: PaintOptions): void {
  const { dpr } = opts;
  const cellDev = Math.max(1, Math.round((opts.cell ?? 3) * dpr));
  const left = Math.round(rect.x * dpr);
  const right = Math.round((rect.x + rect.w) * dpr);
  const top = Math.round(Math.max(rect.y, opts.revealFromY ?? -Infinity) * dpr);
  const bottom = Math.round((rect.y + rect.h) * dpr);
  if (right <= left || bottom <= top) return;
  ctx.fillStyle = fill.color;
  if (fill.kind === "solid") {
    ctx.fillRect(left, top, right - left, bottom - top);
    return;
  }
  const base = fill.base ?? 1;
  const tip = fill.top ?? 1;
  const fullTop = Math.round(rect.y * dpr);
  const span = Math.max(1, bottom - fullTop);
  const cx0 = Math.floor(left / cellDev);
  const cx1 = Math.ceil(right / cellDev);
  const cy0 = Math.floor(top / cellDev);
  const cy1 = Math.ceil(bottom / cellDev);
  for (let cy = cy0; cy < cy1; cy++) {
    const py0 = Math.max(top, cy * cellDev);
    const py1 = Math.min(bottom, (cy + 1) * cellDev);
    if (py1 <= py0) continue;
    // 0 at the bottom edge, 1 at the top edge of the full (unrevealed) rect.
    const t = Math.min(1, Math.max(0, (bottom - (py0 + py1) / 2) / span));
    const intensity = base + (tip - base) * t;
    for (let cx = cx0; cx < cx1; cx++) {
      if (!ditherOn(cx, cy, intensity)) continue;
      const px0 = Math.max(left, cx * cellDev);
      const px1 = Math.min(right, (cx + 1) * cellDev);
      if (px1 > px0) ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
    }
  }
}

/** Size a canvas backing store to its CSS box × devicePixelRatio; returns the context and size. */
export function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number; dpr: number } | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  return { ctx, width, height, dpr };
}

/** Resolve a CSS color (including var(--token)) against an element. */
export function cssColor(el: Element, value: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return m ? getComputedStyle(el).getPropertyValue(m[1]!).trim() || value : value;
}
