// Notary's design tokens (packages/web/src/design/tokens.css, light set), as values the film can
// use inline. The web app's CSS can't be imported here (Remotion renders its own page), so this
// file mirrors it: change a token there, change it here.
import { Easing, interpolate } from "remotion";

export const C = {
  page: "#FFFFFF",
  subtle: "#F6F8FC",
  hairline: "#E6EAF2",
  text: "#0B0F19",
  muted: "#5B6475",
  faint: "#98A1B3",
  strongMuted: "#3A4252",
  mutedSurface: "#EEF1F7",
  controlLine: "#7D879B",
  accent: "#2F6AEB",
  accentText: "#2457D1",
  accentSoft: "#E8F0FE",
  washLavender: "#EFE9FB",
  washPeach: "#FCEFE4",
  washMint: "#E5F4EF",
  washSky: "#E6EFFC",
  certified: "#16A34A",
  certifiedText: "#15803D",
  certifiedBg: "#F0FDF4",
  unsafe: "#DC2626",
  unsafeText: "#B91C1C",
  unsafeBg: "#FEF2F2",
  held: "#D97706",
  heldText: "#B45309",
  heldBg: "#FFF7E8",
  revoked: "#6B7280",
  sky1: "#2F62E6",
  sky2: "#4F84EE",
  sky3: "#8DB8F5",
  sky4: "#D6E6FB",
  sky5: "#FFFFFF",
  skyLilac: "rgb(233 221 251 / 0.4)",
  skyScrim: "rgb(24 60 180 / 0.7)",
} as const;

export const SANS = '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif';
export const SERIF = '"Instrument Serif", Georgia, serif';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const R = { card: 20, section: 28, button: 10, pill: 999 } as const;

export const SHADOW_SOFT = "0 1px 2px rgb(11 15 25 / 0.04)";
export const SHADOW_FLOAT = "0 1px 2px rgb(11 15 25 / 0.04), 0 8px 24px rgb(47 106 235 / 0.08)";
/** The film is viewed larger than a web card; the float shadow scaled up with the type. */
export const SHADOW_FILM = "0 2px 4px rgb(11 15 25 / 0.04), 0 18px 48px rgb(47 106 235 / 0.10)";

export const SKY_GRADIENT = `radial-gradient(70% 45% at 0% 100%, ${C.skyLilac}, transparent 72%), linear-gradient(180deg, ${C.sky1} 0%, ${C.sky1} 34%, ${C.sky2} 52%, ${C.sky3} 67%, ${C.sky4} 83%, ${C.sky5} 100%)`;

/** Display type: serif 400 only (never bolded), −0.02em tracking, 1.05 leading. */
export const display = { fontFamily: SERIF, fontWeight: 400, letterSpacing: "-0.02em", lineHeight: 1.05 } as const;

// ------------------------------------------------------------------------------- motion
// One easing family for the whole film.

/** Entrances and settles: cubic-bezier(.2,.7,.1,1). */
export const OUT = Easing.bezier(0.2, 0.7, 0.1, 1);
/** Exits: a short ease-in. */
export const IN = Easing.bezier(0.55, 0, 0.75, 0.2);
/** The camera: a long, symmetric move. */
export const CAMERA = Easing.bezier(0.7, 0, 0.18, 1);
/** Progress bars and drawn lines. */
export const LINE = Easing.bezier(0.45, 0, 0.2, 1);

/** 0 → 1 between two frames, eased and clamped. */
export function p(frame: number, start: number, duration: number, easing: (t: number) => number = OUT): number {
  return interpolate(frame, [start, start + duration], [0, 1], { easing, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

/** Linear map of a 0–1 progress to a range. */
export const mix = (t: number, from: number, to: number) => from + (to - from) * t;

/** Enter (rise + fade) then leave (lift + fade): the film's one card motion. */
export function enterLeave(frame: number, enterAt: number, leaveAt: number, opts: { rise?: number; lift?: number; enter?: number; leave?: number } = {}) {
  const { rise = 40, lift = 48, enter = 16, leave = 12 } = opts;
  const a = p(frame, enterAt, enter);
  const b = p(frame, leaveAt, leave, IN);
  return { opacity: a * (1 - b), y: (1 - a) * rise - b * lift, visible: a > 0 && b < 1 };
}

/** Seconds → frames at 30 fps. */
export const s = (seconds: number) => Math.round(seconds * 30);
