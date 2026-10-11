// The landing page (`/`): nav and hero (a dashboard preview built from the Run page's own rows)
// render first; Built with, How it works, Key features, Proof, Notary Chat, Pricing (only when
// public/economics.json lists priced plans), the closing CTA and the footer load as one lazy chunk.
// Copy follows the product-site rules in landing-data (BANNED_WORDS).
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { loadEconomicsPlan, useDataSource } from "./data";
import { pricingPlans, seeItWorkHref, type PricingPlan } from "./landing-data";
import { Hero } from "./components/landing/Hero";
import { Nav } from "./components/landing/Nav";
import "./landing.css";

const Below = lazy(() => import("./components/landing/Below"));

export default function Landing() {
  const { source, ready } = useDataSource();
  const hero = useRef<HTMLElement>(null);
  const [plans, setPlans] = useState<PricingPlan[] | null>(null);

  useEffect(() => {
    document.title = "Notary: no certificate, no money moves";
    // Lets landing.css keep the app-wide data-mode banner off this page (cheaper than :has()).
    document.documentElement.dataset.page = "landing";
    return () => {
      delete document.documentElement.dataset.page;
    };
  }, []);

  // The cfo.ai plan: priced plans or nothing (the section and its nav link stay hidden).
  useEffect(() => {
    const controller = new AbortController();
    loadEconomicsPlan(controller.signal).then(
      (raw) => !controller.signal.aborted && setPlans(pricingPlans(raw)),
      () => !controller.signal.aborted && setPlans(null),
    );
    return () => controller.abort();
  }, []);

  // "See it work": VITE_NOTARY_VIDEO_URL when set (no video exists today), else How it works.
  const seeIt = seeItWorkHref(import.meta.env.VITE_NOTARY_VIDEO_URL as string | undefined);

  return (
    <div className="landing theme-light">
      <a className="l-skip" href="#landing-main">
        Skip to content
      </a>
      <Nav showPricing={!!plans} />
      <main id="landing-main" className="l-main">
        <Hero heroRef={hero} source={source} seeIt={seeIt} />
        <Suspense fallback={<div className="l-below-pending" />}>
          <Below source={source} ready={ready} plans={plans} />
        </Suspense>
      </main>
    </div>
  );
}
