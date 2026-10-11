import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import type { DataSource } from "../../data";
import { mockupAddress } from "../../landing-data";
import { Clouds } from "../brand/Clouds";
import { BrowserFrame } from "./BrowserFrame";
import { gsap, MOTION_OK, SplitText, useGSAP } from "./gsap";
import { replayFor, replayPair } from "./replay";

const RunPreview = lazy(() => import("./RunPreview"));
/** The preview's design width (scaled to the frame). */
const SHOT_WIDTH = 1280;

/**
 * The preview is decoration whose data costs a bundle hash: load it on the visitor's first
 * interaction (pointer, touch, key, wheel or scroll) or after 8 s, whichever comes first, so the
 * first render and the main thread stay free.
 */
function useEngaged() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
    const go = () => setOn(true);
    const timer = window.setTimeout(go, 8000);
    for (const e of events) window.addEventListener(e, go, { once: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, go);
    };
  }, []);
  return on;
}

export function Hero({
  heroRef,
  source,
  seeIt,
}: {
  heroRef: RefObject<HTMLElement | null>;
  source: DataSource;
  /** Where "See it work" goes (landing-data seeItWorkHref). */
  seeIt: { href: string; external: boolean };
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const idle = useEngaged();
  const [run, setRun] = useState(false);
  const [address, setAddress] = useState("");
  const replay = replayFor(source);

  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => setAddress(mockupAddress(window.location.origin)), []);
  // The Run page renders at a fixed desktop width; scale it to the frame.
  useEffect(() => {
    const el = screen.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) el.style.setProperty("--shot-scale", String(entry.contentRect.width / SHOT_WIDTH));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!idle) return;
    let live = true;
    replayPair(replay).then(
      (p) => live && setRun(!!p.guarded),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [idle, replay]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const split = SplitText.create(title.current!, { type: "words", tag: "span", aria: "auto" });
        const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
        // 6 words: 0.5 s + 5 × 0.06 s = 0.8 s.
        tl.from(split.words, { y: 24, opacity: 0, duration: 0.5, stagger: 0.06 })
          .from(".l-hero-sub, .l-hero-actions", { y: 16, opacity: 0, duration: 0.5, stagger: 0.08 }, "-=0.3")
          .from(".l-shot-rise", { y: 96, opacity: 0, duration: 1, ease: "power2.out" }, "-=0.45");
        // Gentle parallax while the hero scrolls away.
        gsap.fromTo(
          ".l-shot-parallax",
          { scale: 0.96, y: 0 },
          {
            scale: 1,
            y: -48,
            ease: "none",
            scrollTrigger: { trigger: heroRef.current, start: "top top", end: "bottom top", scrub: true },
          },
        );
      });
    },
    { scope: heroRef },
  );

  return (
    <section ref={heroRef} className="l-hero sky" aria-labelledby="hero-title">
      <div className="l-hero-copy">
        <h1 id="hero-title" ref={title} className="l-hero-title">
          No certificate, <br />
          no money <em>moves</em>.
        </h1>
        <p className="l-hero-sub">An agent that won’t touch money until it has proven how its tools actually behave.</p>
        <div className="l-hero-actions">
          <Link className="btn btn-ink l-btn-lg" to="/app">
            Open dashboard
          </Link>
          {seeIt.external ? (
            <a className="btn btn-link-light l-btn-lg" href={seeIt.href} rel="noreferrer">
              See it work
            </a>
          ) : (
            <a className="btn btn-link-light l-btn-lg" href={seeIt.href}>
              See it work
            </a>
          )}
        </div>
      </div>
      <div className="l-shot-rise">
        <div className="l-shot-parallax">
          <BrowserFrame
            className="l-shot"
            address={address}
            decorative
          >
            <div className="l-shot-screen" ref={screen}>
              {run && idle ? (
                <Suspense fallback={<ShotSkeleton />}>
                  <div className="l-shot-app" style={{ width: SHOT_WIDTH }}>
                    <RunPreview replay={replay} />
                  </div>
                </Suspense>
              ) : (
                <ShotSkeleton />
              )}
            </div>
          </BrowserFrame>
        </div>
      </div>
      <Clouds className="l-hero-clouds" />
    </section>
  );
}

function ShotSkeleton() {
  return (
    <div className="l-shot-skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
