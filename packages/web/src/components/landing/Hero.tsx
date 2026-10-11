import { useRef } from "react";
import { Link } from "react-router";
import { GITHUB_URL } from "../../landing-data";
import { gsap, MOTION_OK, SplitText, useGSAP } from "./gsap";

// The headline is the only text animation on the page besides the counters: words rise and fade
// in, staggered, under one second in total (6 words: 0.5 s + 5 × 0.07 s = 0.85 s).
export function Hero() {
  const root = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const split = SplitText.create(title.current!, { type: "words", mask: "words", tag: "span", aria: "auto" });
        gsap.from(split.words, {
          yPercent: 100,
          opacity: 0,
          duration: 0.5,
          stagger: 0.07,
          ease: "power3.out",
        });
      });
    },
    { scope: root },
  );

  return (
    <section className="l-hero" ref={root} aria-labelledby="hero-title">
      <h1 id="hero-title" ref={title} className="l-hero-title">
        No certificate,{" "}
        <br />
        no money moves.
      </h1>
      <p className="l-hero-sub">
        Notary is an agent that won’t touch money until it has proven how its tools behave, and
        anything it can’t prove waits for a person to approve.
      </p>
      <div className="l-actions">
        <Link className="l-btn l-btn-solid" to="/app">
          Open dashboard
        </Link>
        <a className="l-btn" href={GITHUB_URL} rel="noreferrer">
          View on GitHub
        </a>
      </div>
    </section>
  );
}
