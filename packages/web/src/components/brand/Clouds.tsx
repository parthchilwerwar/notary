// Clouds drawn in code (no images): three layers of white radial-gradient puffs, each softened by
// a heavy blur plus an SVG feTurbulence/feDisplacementMap filter so the edges look like vapor, at
// different opacities. Each layer drifts horizontally on a slow seamless loop (60 s and longer,
// a different speed per layer) and pauses while off screen. Reduced motion: no drift.
//
// Each layer's track is three identical copies side by side and moves by one copy (-33.33%), so
// the loop has no seam (puffs that overflow a copy's edge are matched by the next copy). The filter and the transform sit on the same element with will-change, so the filtered
// layer is rasterized once and only translated afterwards (never re-filtered per frame).
import { useId, useRef, type CSSProperties } from "react";
import { gsap, MOTION_OK, ScrollTrigger, useGSAP } from "./gsap";
import "./brand.css";

/** One puff: center x/y in % of one copy of the track, size in % of the layer height, opacity 0–1. */
type Puff = readonly [x: number, y: number, w: number, h: number, a: number];

type Layer = { puffs: readonly Puff[]; opacity: number; blur: number; seconds: number; height: string; bottom: string };

// Decorative geometry only (no data). Back layer: big, faint, slow. Front layer: dense, opaque.
const LAYERS: readonly Layer[] = [
  {
    opacity: 0.55,
    blur: 18,
    seconds: 150,
    height: "78%",
    bottom: "22%",
    puffs: [
      [6, 62, 32, 70, 0.9],
      [24, 48, 40, 80, 0.8],
      [46, 66, 34, 64, 0.85],
      [66, 50, 42, 82, 0.8],
      [88, 60, 34, 70, 0.9],
    ],
  },
  {
    opacity: 0.8,
    blur: 12,
    seconds: 100,
    height: "64%",
    bottom: "10%",
    puffs: [
      [3, 66, 24, 70, 1],
      [17, 56, 28, 86, 0.95],
      [34, 70, 24, 64, 1],
      [50, 58, 30, 90, 0.95],
      [67, 68, 24, 66, 1],
      [83, 56, 28, 88, 0.95],
      [97, 66, 22, 68, 1],
    ],
  },
  {
    opacity: 1,
    blur: 8,
    seconds: 70,
    height: "46%",
    bottom: "0%",
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
  },
];

function Half({ puffs }: { puffs: readonly Puff[] }) {
  return (
    <div className="clouds-half">
      {puffs.map(([x, y, w, h, a], i) => (
        <span
          key={i}
          className="clouds-puff"
          style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`, opacity: a } as CSSProperties}
        />
      ))}
    </div>
  );
}

export function Clouds({ className, base = true }: { className?: string; base?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const filterId = `clouds-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const tracks = gsap.utils.toArray<HTMLElement>(".clouds-track", root.current);
        const tweens = tracks.map((track, i) =>
          gsap.to(track, { xPercent: -100 / 3, duration: LAYERS[i]!.seconds, ease: "none", repeat: -1 }),
        );
        // Looping motion must stop while off screen.
        ScrollTrigger.create({
          trigger: root.current,
          start: "top bottom",
          end: "bottom top",
          onToggle: (self) => tweens.forEach((t) => (self.isActive ? t.play() : t.pause())),
        });
      });
    },
    { scope: root },
  );

  return (
    <div ref={root} className={["clouds", className].filter(Boolean).join(" ")} aria-hidden="true">
      <svg className="clouds-defs" width="0" height="0" focusable="false">
        <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="48" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      {LAYERS.map((layer, i) => (
        <div
          key={i}
          className="clouds-layer"
          style={{ opacity: layer.opacity, height: layer.height, bottom: layer.bottom }}
        >
          <div className="clouds-track" style={{ filter: `url(#${filterId}) blur(${layer.blur}px)` }}>
            <Half puffs={layer.puffs} />
            <Half puffs={layer.puffs} />
            <Half puffs={layer.puffs} />
          </div>
        </div>
      ))}
      {base && <div className="clouds-base" />}
    </div>
  );
}
