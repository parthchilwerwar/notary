import { useRef } from "react";
import { Link } from "react-router";
import { Clouds } from "../brand/Clouds";
import { drawStrokes, revealTitle } from "./motion";
import { gsap, MOTION_OK, useGSAP } from "./gsap";

// Orbits behind the closing headline (decorative; no data). Nodes sit on the ellipses.
const ORBITS = [
  { rx: 300, ry: 118 },
  { rx: 430, ry: 170 },
  { rx: 560, ry: 222 },
] as const;
const NODE_ANGLES = [[200, 340], [24, 150, 260], [70, 196, 318]] as const;

export function ClosingCta() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        revealTitle(root.current!.querySelector(".l-cta-title"));
        drawStrokes(gsap.utils.toArray<SVGGeometryElement>(".l-draw", root.current), root.current, 1.8);
      });
    },
    { scope: root },
  );
  return (
    <section ref={root} className="l-cta sky" aria-labelledby="cta-title">
      <svg className="l-cta-orbits" viewBox="-600 -260 1200 520" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          {ORBITS.map((o, i) => (
            <mask key={i} id={`cta-orbit-${i}`} maskUnits="userSpaceOnUse" x="-600" y="-260" width="1200" height="520">
              <ellipse className="l-draw" cx="0" cy="0" rx={o.rx} ry={o.ry} fill="none" stroke="#fff" strokeWidth="6" />
            </mask>
          ))}
        </defs>
        {ORBITS.map((o, i) => (
          <g key={i}>
            <ellipse className="l-cta-orbit" cx="0" cy="0" rx={o.rx} ry={o.ry} mask={`url(#cta-orbit-${i})`} />
            {NODE_ANGLES[i]!.map((deg) => {
              const t = (deg * Math.PI) / 180;
              return <circle key={deg} className="l-cta-node" cx={o.rx * Math.cos(t)} cy={o.ry * Math.sin(t)} r="5" />;
            })}
          </g>
        ))}
      </svg>
      <div className="l-cta-inner">
        <h2 id="cta-title" className="l-cta-title">
          Let your agent prove it first.
        </h2>
        <Link className="btn btn-ink l-btn-lg" to="/app">
          Open dashboard
        </Link>
      </div>
      <Clouds className="l-cta-clouds" />
    </section>
  );
}
