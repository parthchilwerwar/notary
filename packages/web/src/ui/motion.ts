// The landing's GSAP language, lighter, for dashboard pages: the band title's words rise in once,
// cards fade up in sequence, Stat numbers count up, Timeline rows slide in as they stream. All of
// it runs inside gsap.matchMedia(MOTION_OK), so reduced motion shows everything at once, unmoving.
import { useRef, type RefObject } from "react";
import { gsap, MOTION_OK, ScrollTrigger, SplitText, useGSAP } from "../components/brand/gsap";

export { gsap, MOTION_OK, useGSAP };

const fmt = new Intl.NumberFormat("en-US");

/** Count every `.ui-count[data-count]` in `scope` up from 0 once (the final text is restored on revert). */
function countUp(scope: Element) {
  const els = gsap.utils.toArray<HTMLElement>(".ui-count[data-count]", scope);
  for (const el of els) {
    const target = Number(el.dataset.count);
    const text = el.firstChild as Text | null;
    if (!text || !Number.isFinite(target) || el.dataset.counted) continue;
    el.dataset.counted = "1";
    const format = (n: number) => (el.dataset.decimals ? n.toFixed(Number(el.dataset.decimals)) : fmt.format(Math.round(n)));
    const counter = { v: 0 };
    text.nodeValue = format(0);
    gsap.to(counter, {
      v: target,
      duration: 1.1,
      ease: "power2.out",
      onUpdate: () => {
        text.nodeValue = format(counter.v);
      },
      onComplete: () => {
        text.nodeValue = format(target);
      },
    });
  }
  return () => {
    for (const el of els) {
      const text = el.firstChild as Text | null;
      const target = Number(el.dataset.count);
      if (text && Number.isFinite(target))
        text.nodeValue = el.dataset.decimals ? target.toFixed(Number(el.dataset.decimals)) : fmt.format(target);
      delete el.dataset.counted;
    }
  };
}

/**
 * Page motion for a dashboard page root: band title word reveal, `[data-reveal]` cards fading up in
 * sequence, Stat count-up. Re-runs when `deps` change (e.g. data arrives).
 */
export function usePageMotion(deps: unknown[] = []): RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const title = el.querySelector<HTMLElement>(".ui-band-title:not([data-split])");
        if (title) {
          title.dataset.split = "1";
          const split = SplitText.create(title, { type: "words", tag: "span", aria: "auto" });
          gsap.from(split.words, { y: 16, opacity: 0, duration: 0.5, stagger: 0.05, ease: "power3.out" });
        }
        const cards = gsap.utils.toArray<HTMLElement>("[data-reveal]:not([data-revealed])", el);
        if (cards.length) {
          for (const c of cards) c.dataset.revealed = "1";
          gsap.set(cards, { opacity: 0, y: 24 });
          ScrollTrigger.batch(cards, {
            start: "top 95%",
            once: true,
            onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 0.55, ease: "power2.out", stagger: 0.08, overwrite: true }),
          });
        }
        const undoCount = countUp(el);
        return () => {
          undoCount();
          if (title) delete title.dataset.split;
          for (const c of cards) delete c.dataset.revealed;
        };
      });
    },
    { scope: root, dependencies: deps, revertOnUpdate: true },
  );
  return root;
}

/**
 * Slide a newly streamed Timeline row in (opacity + transform, short). Idempotent: explicit start
 * and end values (fromTo, overwrite), so a second call — e.g. React StrictMode re-running an
 * effect — restarts from the start state and always ends visible. No-op under reduced motion.
 */
export function slideIn(el: Element | null) {
  if (!el || typeof window === "undefined" || !window.matchMedia(MOTION_OK).matches) return;
  gsap.fromTo(el, { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: 0.25, ease: "power2.out", overwrite: true, clearProps: "opacity,transform" });
}
