import { lazy, Suspense, useRef } from "react";
import type { DataSource } from "../../data";
import { HOW_STEPS } from "../../landing-data";
import { GridSection } from "../brand/GridFrame";
import { fadeUp, revealTitle } from "./motion";
import { gsap, MOTION_OK, useGSAP } from "./gsap";
import { useNear } from "./useNear";

// A bento of three cards. Each visual is built from the dashboard's own UI vocabulary and real
// exported records (a probe's committed prediction and its observation, an Adversary review, a
// certificate and two of the guarded run's decisions), loaded lazily when the section nears.
const HowArt = lazy(() => import("./HowArt"));

export function HowItWorks({ source }: { source: DataSource }) {
  const root = useRef<HTMLElement>(null);
  const near = useNear(root, 300);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        revealTitle(root.current!.querySelector(".l-h2"));
        fadeUp(gsap.utils.toArray<HTMLElement>(".l-how-card", root.current), { stagger: 0.12, y: 32 });
      });
    },
    { scope: root },
  );

  return (
    <GridSection ref={root} id="how" className="l-section l-how" aria-labelledby="how-title" rule>
      <div className="grid-inner">
        <header className="l-section-head">
          <p className="section-label">How it works</p>
          <h2 id="how-title" className="display l-h2">
            It tests the API before it trusts the docs
          </h2>
        </header>
        <ol className="l-how-grid">
          {HOW_STEPS.map((s) => (
            <li key={s.id} className={`l-how-card wash wash-${s.wash}`} data-step={s.id}>
              <div className="l-how-visual">
                {near ? (
                  <Suspense fallback={<div className="l-how-pending" aria-hidden="true" />}>
                    <HowArt kind={s.id} source={source} />
                  </Suspense>
                ) : (
                  <div className="l-how-pending" aria-hidden="true" />
                )}
              </div>
              <div className="l-how-copy">
                <h3 className="l-how-title">{s.title}</h3>
                <p className="l-how-body">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </GridSection>
  );
}
