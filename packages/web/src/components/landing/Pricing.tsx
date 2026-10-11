import { useRef } from "react";
import { PUBLISHED_FILES } from "../../data";
import { planPrice, type PricingPlan } from "../../landing-data";
import { GridSection } from "../brand/GridFrame";
import { fadeUp, revealTitle } from "./motion";
import { gsap, MOTION_OK, useGSAP } from "./gsap";

/**
 * Three plans from public/economics.json (the cfo.ai plan). Rendered only when the file lists
 * three priced plans (landing-data `pricingPlans`); otherwise the section and its nav link are
 * hidden. The middle card sits on the sky gradient.
 */
export function Pricing({ plans }: { plans: readonly PricingPlan[] }) {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        revealTitle(root.current!.querySelector(".l-h2"));
        fadeUp(gsap.utils.toArray<HTMLElement>(".l-plan", root.current), { stagger: 0.12 });
      });
    },
    { scope: root },
  );
  return (
    <GridSection ref={root} id="pricing" className="l-section l-pricing" aria-labelledby="pricing-title" rule>
      <div className="grid-inner">
        <header className="l-section-head l-center">
          <p className="section-label">Pricing</p>
          <h2 id="pricing-title" className="display l-h2">
            Plans from the published business model
          </h2>
          <p className="l-lede">From the cfo.ai plan published in {PUBLISHED_FILES.economics}.</p>
        </header>
        <ul className="l-plans">
          {plans.map((p, i) => (
            <li key={p.name} className={i === 1 ? "l-plan l-plan-sky sky" : "l-plan"}>
              <h3 className="l-plan-name">{p.name}</h3>
              <p className="l-plan-price">
                <span className="num">{planPrice(p)}</span> <span className="l-plan-period">/ {p.period}</span>
              </p>
              {p.description && <p className="l-plan-desc">{p.description}</p>}
              {p.features && p.features.length > 0 && (
                <ul className="l-plan-features">
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </GridSection>
  );
}
