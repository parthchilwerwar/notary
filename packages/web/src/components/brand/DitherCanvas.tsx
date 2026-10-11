// Shared dither components (D1 brand). Crisp, devicePixelRatio-aware canvases using the ordered
// Bayer 8×8 renderer in ./dither.ts.
//
//   <DitherCanvas draw={(paint, size) => { paint({x, y, w, h}, {kind: "dither", color: "var(--status-held)", base: 1, top: 0.35}) }}
//                 deps={[data, progress]} className="…" role="img" aria-label="…" />
//     Redraws when `deps` change, on resize (ResizeObserver) and on devicePixelRatio changes.
//     `paint(rect, fill, { revealFromY? })` paints in CSS px; colors may be var(--token).
//
//   <DitherSwatch fill={…} size={12} />   a small legend swatch with the same pattern.
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type HTMLAttributes } from "react";
import { cssColor, fitCanvas, paintRect, type DitherFill, type Rect } from "./dither";

export { BAYER8, ditherOn, paintRect, fitCanvas, type DitherFill, type Rect } from "./dither";

export type Paint = (rect: Rect, fill: DitherFill, opts?: { revealFromY?: number }) => void;
export type DrawFn = (paint: Paint, size: { width: number; height: number; dpr: number }) => void;

const crisp: CSSProperties = { imageRendering: "pixelated", display: "block" };

export function DitherCanvas({
  draw,
  deps,
  cell = 3,
  style,
  ...rest
}: { draw: DrawFn; deps: readonly unknown[]; cell?: number } & Omit<HTMLAttributes<HTMLCanvasElement>, "children">) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const render = () => {
    const canvas = ref.current;
    if (!canvas) return;
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx, width, height, dpr } = fit;
    const paint: Paint = (rect, fill, opts) =>
      paintRect(ctx, rect, { ...fill, color: cssColor(canvas, fill.color) }, { dpr, cell, revealFromY: opts?.revealFromY });
    drawRef.current(paint, { width, height, dpr });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(render, deps);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => render()) : null;
    ro?.observe(canvas);
    // devicePixelRatio changes (zoom, moving between screens).
    let mq: MediaQueryList | null = null;
    const onDpr = () => {
      render();
      watch();
    };
    const watch = () => {
      mq?.removeEventListener("change", onDpr);
      mq = typeof matchMedia === "function" ? matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`) : null;
      mq?.addEventListener("change", onDpr);
    };
    watch();
    return () => {
      ro?.disconnect();
      mq?.removeEventListener("change", onDpr);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} style={{ ...crisp, ...style }} {...rest} />;
}

/** A legend swatch drawn with the same pattern (decorative). */
export function DitherSwatch({ fill, size = 12, cell = 2, className }: { fill: DitherFill; size?: number; cell?: number; className?: string }) {
  return (
    <DitherCanvas
      aria-hidden="true"
      className={className}
      cell={cell}
      style={{ width: size, height: size, borderRadius: 2 }}
      deps={[fill.kind, fill.color, fill.kind === "dither" ? fill.base : 0, fill.kind === "dither" ? fill.top : 0]}
      draw={(paint, s) => paint({ x: 0, y: 0, w: s.width, h: s.height }, fill)}
    />
  );
}
