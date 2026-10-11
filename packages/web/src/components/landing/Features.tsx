import { lazy, Suspense, useRef } from "react";
import type { DataSource } from "../../data";
import { FEATURES } from "../../landing-data";
import { GridSection } from "../brand/GridFrame";
import { fadeUp, revealTitle } from "./motion";
import { gsap, MOTION_OK, useGSAP } from "./gsap";
import { useNear } from "./useNear";

// The mini-cards are real dashboard components fed with exported data; their code and data load only when
// the section nears the viewport.
const FeatureArt = lazy(() => import("./FeatureMinis"));

export function Features({ source }: { source: DataSource }) {
  const root = useRef<HTMLElement>(null);
  const near = useNear(root);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        revealTitle(root.current!.querySelector(".l-h2"));
        fadeUp(gsap.utils.toArray<HTMLElement>(".l-feature", root.current), { stagger: 0.12, y: 36 });
      });
    },
    { scope: root },
  );

  return (
    <GridSection ref={root} id="features" className="l-section l-features" aria-labelledby="features-title" rule>
      <div className="grid-inner">
        <header className="l-section-head">
          <p className="section-label">Key features</p>
          <h2 id="features-title" className="display l-h2">
            Everything your agent must prove before it pays
          </h2>
        </header>
        <div className="l-feature-grid">
          {FEATURES.map((f) => (
            <article key={f.key} className={`l-feature wash wash-${f.wash}`} aria-labelledby={`feature-${f.key}`}>
              <div className="l-feature-art">
                {near ? (
                  <Suspense fallback={<div className="l-mini l-mini-pending" aria-hidden="true" />}>
                    <FeatureArt kind={f.key} source={source} />
                  </Suspense>
                ) : (
                  <div className="l-mini l-mini-pending" aria-hidden="true" />
                )}
              </div>
              <div className="l-feature-copy">
                <span className="l-feature-n" aria-hidden="true">
                  {f.n}
                </span>
                <h3 id={`feature-${f.key}`} className="l-feature-title">
                  {f.title}
                </h3>
                <p className="l-feature-body">{f.body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </GridSection>
  );
}
