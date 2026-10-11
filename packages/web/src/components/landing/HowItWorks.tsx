import { useRef } from "react";
import { STAGES, STAGE_LABEL, STEP_COPY } from "../../landing-data";
import { gsap, MOTION_OK, useGSAP } from "./gsap";

// Five plain rows, one per timeline stage; each is revealed as it enters the viewport.
export function HowItWorks() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        for (const row of gsap.utils.toArray<HTMLElement>(".l-step", root.current)) {
          gsap.from(row, {
            opacity: 0,
            y: 24,
            duration: 0.6,
            ease: "power2.out",
            scrollTrigger: { trigger: row, start: "top 88%", once: true },
          });
        }
      });
    },
    { scope: root },
  );

  return (
    <section className="l-section" ref={root} aria-labelledby="how-title">
      <h2 id="how-title" className="l-h2">
        How it works
      </h2>
      <ol className="l-steps">
        {STAGES.map((stage) => (
          <li key={stage} className="l-step">
            <h3 className="l-step-name">{STAGE_LABEL[stage]}</h3>
            <p className="l-step-copy">{STEP_COPY[stage]}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
