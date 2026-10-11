// GSAP: the one animation library (DECISIONS #152). Plugins are registered once, here, before any
// component calls useGSAP. SplitText and ScrollTrigger ship free in the public gsap package
// (3.13+; installed 3.15.0). Brand components (Clouds) and the landing import from this module.
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText);

/** Animations run only under this query; reduced motion shows everything at once, unmoving. */
export const MOTION_OK = "(prefers-reduced-motion: no-preference)";

export { gsap, ScrollTrigger, SplitText, useGSAP };
