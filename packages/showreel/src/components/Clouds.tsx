// The landing's clouds (packages/web/src/components/brand/Clouds.tsx), driven by the frame instead
// of a GSAP loop: three layers of white radial-gradient puffs, each softened by a blur plus an SVG
// feTurbulence/feDisplacementMap filter (fixed seed, so every frame renders identically), drifting
// sideways at their own slow speeds. `lift` moves each layer vertically by its own depth factor,
// which is the parallax of the camera passing through them.
import type { CSSProperties } from "react";
import { useCurrentFrame } from "remotion";

/** One puff: center x/y in % of one copy of the track, size in % of the layer height, opacity 0–1. */
type Puff = readonly [x: number, y: number, w: number, h: number, a: number];

export type CloudLayer = {
  puffs: readonly Puff[];
  opacity: number;
  blur: number;
  /** Horizontal drift in px per frame. */
  drift: number;
  /** Layer box height and bottom offset, in % of the cloud field. */
  height: number;
  bottom: number;
  /** Parallax factor applied to `lift`. */
  depth: number;
};

// Decorative geometry from the landing (no data). Back: big, faint, slow. Front: dense, opaque.
export const BACK: CloudLayer = {
  opacity: 0.55,
  blur: 22,
  drift: 0.22,
  height: 78,
  bottom: 22,
  depth: 0.82,
  puffs: [
    [6, 62, 32, 70, 0.9],
    [24, 48, 40, 80, 0.8],
    [46, 66, 34, 64, 0.85],
    [66, 50, 42, 82, 0.8],
    [88, 60, 34, 70, 0.9],
  ],
};
export const MID: CloudLayer = {
  opacity: 0.8,
  blur: 15,
  drift: 0.4,
  height: 64,
  bottom: 10,
  depth: 1,
  puffs: [
    [3, 66, 24, 70, 1],
    [17, 56, 28, 86, 0.95],
    [34, 70, 24, 64, 1],
    [50, 58, 30, 90, 0.95],
    [67, 68, 24, 66, 1],
    [83, 56, 28, 88, 0.95],
    [97, 66, 22, 68, 1],
  ],
};
export const FRONT: CloudLayer = {
  opacity: 1,
  blur: 10,
  drift: 0.7,
  height: 46,
  bottom: 0,
  depth: 1.5,
  puffs: [
    [0, 70, 20, 90, 1],
    [12, 64, 22, 100, 1],
    [25, 72, 20, 86, 1],
    [38, 62, 24, 104, 1],
    [52, 72, 20, 88, 1],
    [65, 64, 22, 100, 1],
    [78, 72, 20, 86, 1],
    [91, 64, 22, 100, 1],
  ],
};

const puffStyle: CSSProperties = {
  position: "absolute",
  borderRadius: "50%",
  background: "radial-gradient(closest-side, #ffffff 0%, #ffffff 52%, rgb(255 255 255 / 0.85) 70%, rgb(255 255 255 / 0) 100%)",
  transform: "translate(-50%, -50%)",
};

function Copy({ puffs }: { puffs: readonly Puff[] }) {
  return (
    <div style={{ position: "relative", flex: "1 1 0", height: "100%" }}>
      {puffs.map(([x, y, w, h, a], i) => (
        <span key={i} style={{ ...puffStyle, left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`, opacity: a }} />
      ))}
    </div>
  );
}

/** The shared turbulence filter (render once per composition, before any layer). */
export function CloudFilter({ id, scale = 64 }: { id: string; scale?: number }) {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale={scale} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}

/**
 * One layer over a field of `fieldHeight` px whose bottom sits at `bottom` px from the top of the
 * frame. `lift` (px) moves the layer up by lift × depth.
 */
export function Clouds({
  layer,
  filterId,
  fieldHeight,
  fieldBottom,
  width,
  lift = 0,
  phase = 0,
  opacity = 1,
}: {
  layer: CloudLayer;
  filterId: string;
  fieldHeight: number;
  fieldBottom: number;
  width: number;
  lift?: number;
  phase?: number;
  opacity?: number;
}) {
  const frame = useCurrentFrame();
  const h = (layer.height / 100) * fieldHeight;
  const top = fieldBottom - (layer.bottom / 100) * fieldHeight - h - lift * layer.depth;
  // Track of three identical copies; start one copy to the left so drift never shows an edge.
  const x = -width - phase - frame * layer.drift;
  return (
    <div style={{ position: "absolute", left: 0, top, width, height: h, opacity: layer.opacity * opacity, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          display: "flex",
          width: width * 3,
          height: "100%",
          transform: `translateX(${x}px)`,
          filter: `url(#${filterId}) blur(${layer.blur}px)`,
        }}
      >
        <Copy puffs={layer.puffs} />
        <Copy puffs={layer.puffs} />
        <Copy puffs={layer.puffs} />
      </div>
    </div>
  );
}
