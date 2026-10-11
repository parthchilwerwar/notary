// Shared landing motion, all GSAP and all inside `gsap.matchMedia(MOTION_OK)` by the caller, so
// reduced motion shows everything immediately. Body text is never animated on its own.
import { gsap, ScrollTrigger, SplitText } from "./gsap";

/** One-time word reveal of a section headline when it enters the viewport. */
export function revealTitle(el: Element | null) {
  if (!el) return;
  const split = SplitText.create(el, { type: "words", tag: "span", aria: "auto" });
  gsap.from(split.words, {
    y: 18,
    opacity: 0,
    duration: 0.5,
    stagger: 0.05,
    ease: "power3.out",
    scrollTrigger: { trigger: el, start: "top 85%", once: true },
  });
}

/** Staggered fade-up of cards / columns as they enter (one batch per group entering together). */
export function fadeUp(targets: Element[], opts: { y?: number; stagger?: number } = {}) {
  if (!targets.length) return;
  gsap.set(targets, { opacity: 0, y: opts.y ?? 28 });
  ScrollTrigger.batch(targets, {
    start: "top 88%",
    once: true,
    onEnter: (batch) =>
      gsap.to(batch, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out", stagger: opts.stagger ?? 0.1, overwrite: true }),
  });
}

/** Draw SVG strokes in (stroke-dashoffset) once, when `trigger` enters. Dashed strokes keep their dashes via a mask copy. */
export function drawStrokes(paths: SVGGeometryElement[], trigger: Element | null, duration = 1.4) {
  if (!paths.length || !trigger) return;
  for (const p of paths) {
    const len = Math.ceil(p.getTotalLength());
    gsap.set(p, { strokeDasharray: len, strokeDashoffset: len });
  }
  gsap.to(paths, {
    strokeDashoffset: 0,
    duration,
    ease: "power2.inOut",
    stagger: 0.12,
    scrollTrigger: { trigger, start: "top 80%", once: true },
  });
}
