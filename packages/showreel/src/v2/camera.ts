// Keyframed camera and paths. Between two keys every value eases with the film's camera curve
// (slow out, slow in); holds are just repeated keys. Pure functions of the frame.
import { Easing } from "remotion";

export type Cam = { cx: number; cy: number; s: number; rx: number; ry: number; dy: number; o: number };
export type Key<T> = readonly [frame: number, value: T];

const SMOOTH = Easing.bezier(0.6, 0, 0.2, 1);

export function track<T extends Record<string, number>>(frame: number, keys: readonly Key<T>[], ease: (t: number) => number = SMOOTH): T {
  if (frame <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [f1, v1] = keys[i]!;
    const [f0, v0] = keys[i - 1]!;
    if (frame <= f1) {
      const t = ease((frame - f0) / Math.max(1, f1 - f0));
      const out = {} as Record<string, number>;
      for (const k of Object.keys(v1)) out[k] = v0[k]! + (v1[k]! - v0[k]!) * t;
      return out as T;
    }
  }
  return keys.at(-1)![1];
}

/** CSS transform placing local point (cx, cy) of a layer at the frame center, at scale s. */
export function camTransform(c: Cam, w = 1920, h = 1080): string {
  return `translate3d(${w / 2}px, ${h / 2 + c.dy}px, 0) rotateX(${c.rx}deg) rotateY(${c.ry}deg) scale(${c.s}) translate3d(${-c.cx}px, ${-c.cy}px, 0)`;
}

/** Screen position of a local point under a camera (rotation ignored: interactions happen flat). */
export const toScreen = (c: Cam, x: number, y: number) => ({ x: 960 + (x - c.cx) * c.s, y: 540 + c.dy + (y - c.cy) * c.s });

/** A point on a cubic Bézier from a to b with a gentle sideways arc (natural hand movement). */
export function arc(a: { x: number; y: number }, b: { x: number; y: number }, t: number, bend = 0.18) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const nx = -dy * bend;
  const ny = dx * bend;
  const c1 = { x: a.x + dx * 0.3 + nx, y: a.y + dy * 0.3 + ny };
  const c2 = { x: a.x + dx * 0.75 + nx * 0.5, y: a.y + dy * 0.75 + ny * 0.5 };
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** Pointer timing: quick acceleration, a soft overshoot past the target, then settle. */
export function reach(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const base = Easing.bezier(0.3, 0, 0.15, 1)(t);
  return base + Math.sin(Math.PI * t) * Math.sin(Math.PI * t) * 0.035 * (t > 0.6 ? 1 : 0);
}
