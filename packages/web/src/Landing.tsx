// The landing page (`/`): nav and hero (a dashboard preview built from the Run page's own rows)
// render first; Built with, How it works, Key features, Proof, Notary Chat, Pricing (only when
// public/economics.json lists priced plans), the closing CTA and the footer load as one lazy chunk.
// Copy follows the product-site rules in landing-data (BANNED_WORDS).
//
// The development-only fixture view (`?fixtures=1`) is read from the router on every render, and
// the page below the nav is keyed by it: navigating between the two views (even client-side, with
// this module and its caches still loaded) remounts every section, so each loads its own view's
// data. Under the flag the fixture disclosure (FixtureNote) stays visible on the page.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { loadEconomicsPlan, useDataSource } from "./data";
import { cfoPlanImported, pricingPlans, seeItWorkHref, type PricingPlan } from "./landing-data";
import { fixturesRequested } from "./app/links";
import { Hero } from "./components/landing/Hero";
import { Nav } from "./components/landing/Nav";
import "./landing.css";

const Below = lazy(() => import("./components/landing/Below"));
// The kit's fixture note, loaded only in the fixture view (the default view's first chunk stays lean).
const FixtureNote = lazy(() => import("./ui/Bits").then((m) => ({ default: m.FixtureNote })));

export default function Landing() {
  const { source, ready } = useDataSource();
  const { search } = useLocation();
  const fixtures = fixturesRequested(search);
  const hero = useRef<HTMLElement>(null);
  const [plans, setPlans] = useState<PricingPlan[] | null>(null);
  const [cfoPlan, setCfoPlan] = useState<boolean | null>(null);

  useEffect(() => {
    document.title = "Notary: no certificate, no money moves";
  }, []);

  // The cfo.ai plan: priced plans or nothing (the section and its nav link stay hidden).
  useEffect(() => {
    const controller = new AbortController();
    loadEconomicsPlan(controller.signal).then(
      (raw) => {
        if (controller.signal.aborted) return;
        setPlans(pricingPlans(raw));
        setCfoPlan(cfoPlanImported(raw));
      },
      () => {
        if (controller.signal.aborted) return;
        setPlans(null);
        setCfoPlan(false);
      },
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
      <main key={String(fixtures)} id="landing-main" className="l-main">
        {fixtures && (
          <Suspense fallback={null}>
            <FixtureNote className="l-view-note" />
          </Suspense>
        )}
        <Hero heroRef={hero} source={source} seeIt={seeIt} />
        <Suspense fallback={<div className="l-below-pending" />}>
          <Below source={source} ready={ready} plans={plans} cfoPlan={cfoPlan} />
        </Suspense>
      </main>
    </div>
  );
}
