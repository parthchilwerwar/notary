import { useState, type RefObject } from "react";
import { ScrollTrigger, useGSAP } from "./gsap";

/**
 * True once `ref` comes within `margin` px of the viewport. Not an animation: a one-shot
 * visibility trigger that also runs under reduced motion. Used to load lazy sections late.
 */
export function useNear(ref: RefObject<HTMLElement | null>, margin = 600): boolean {
  const [near, setNear] = useState(false);
  useGSAP(
    () => {
      if (!ref.current) return;
      ScrollTrigger.create({
        trigger: ref.current,
        start: `top bottom+=${margin}`,
        once: true,
        onEnter: () => setNear(true),
      });
    },
    { scope: ref },
  );
  return near;
}
