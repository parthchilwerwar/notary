// Beats 1 and 6: the sky (the landing hero and closing CTA). The gradient, back and middle cloud
// layers, the faint grid and the copy all ride the camera: `lift` px up as it pushes down to the
// white page, back to 0 when it pulls up again. The front cloud layer is drawn by Showreel above
// the page, so the camera passes through it.
import { useCurrentFrame } from "remotion";
import { CloudFilter, Clouds, BACK, MID } from "../components/Clouds";
import { Frame } from "../components/Frame";
import { C, SANS, SKY_GRADIENT, display, p, OUT, LINE, mix } from "../theme";
import { T } from "../timeline";

const W = 1920;
const H = 1080;

/** Words that rise 28px and fade in, staggered 2 frames, 15 frames each (the hero's SplitText). */
function RisingWords({ lines, start, size, stagger = 2, dur = 15 }: { lines: { text: string; italic?: boolean; suffix?: string }[][]; start: number; size: number; stagger?: number; dur?: number }) {
  const frame = useCurrentFrame();
  let i = 0;
  return (
    <>
      {lines.map((line, li) => (
        <div key={li} style={{ display: "block", whiteSpace: "nowrap" }}>
          {line.map((w, wi) => {
            const t = p(frame, start + i++ * stagger, dur, OUT);
            return (
              <span key={wi} style={{ display: "inline-block", opacity: t, transform: `translateY(${(1 - t) * 28}px)`, marginRight: wi < line.length - 1 ? size * 0.22 : 0 }}>
                <span style={{ fontStyle: w.italic ? "italic" : "normal" }}>{w.text}</span>
                {w.suffix}
              </span>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** Dashed orbits behind the closing line (ClosingCta.tsx), drawn in by a stroke mask. */
const ORBITS = [
  { rx: 300, ry: 118, nodes: [160, 20] },
  { rx: 430, ry: 170, nodes: [215, 325] },
  { rx: 560, ry: 222, nodes: [] as number[] },
] as const;
const perimeter = (a: number, b: number) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

function Orbits({ draw, nodes, cy }: { draw: number; nodes: number; cy: number }) {
  const sx = 2.45;
  const sy = 2.3;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0 }} aria-hidden="true">
      <defs>
        {ORBITS.map((o, i) => {
          const len = perimeter(o.rx * sx, o.ry * sy);
          const t = Math.min(1, Math.max(0, draw * 1.25 - i * 0.12));
          return (
            <mask key={i} id={`orbit-mask-${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
              <ellipse
                cx={W / 2}
                cy={cy}
                rx={o.rx * sx}
                ry={o.ry * sy}
                fill="none"
                stroke="#fff"
                strokeWidth="8"
                strokeDasharray={len}
                strokeDashoffset={len * (1 - t)}
              />
            </mask>
          );
        })}
      </defs>
      {ORBITS.map((o, i) => (
        <g key={i}>
          <ellipse cx={W / 2} cy={cy} rx={o.rx * sx} ry={o.ry * sy} fill="none" stroke="rgb(255 255 255 / 0.55)" strokeWidth="2" strokeDasharray="5 12" mask={`url(#orbit-mask-${i})`} />
          {o.nodes.map((deg, k) => {
            const a = (deg * Math.PI) / 180;
            const x = W / 2 + o.rx * sx * Math.cos(a);
            const y = cy + o.ry * sy * Math.sin(a);
            // Nodes never sit on the copy or off the frame.
            const onTitle = x > 300 && x < 1620 && y > 280 && y < 460;
            const onMark = x > 680 && x < 1240 && y > 470 && y < 640;
            if (onTitle || onMark || x < 60 || x > W - 60 || y < 60 || y > H - 60) return null;
            const t = Math.min(1, Math.max(0, nodes * 1.6 - (i + k) * 0.14));
            return <circle key={deg} cx={x} cy={y} r={7 * t} fill="#FFFFFF" opacity={0.9 * t} />;
          })}
        </g>
      ))}
    </svg>
  );
}

export function Sky({ lift, github }: { lift: number; github: string }) {
  const frame = useCurrentFrame();
  const opening = frame < T.pullStart;
  // Grid nodes and the wordmark settle in during the first second.
  const grid = p(frame, 0, 24);
  // Closing: orbits, line, wordmark.
  const orbit = p(frame, T.pullStart + 4, 26, LINE);
  const nodes = p(frame, T.pullStart + 16, 14);
  const mark = p(frame, T.wordmark, 14);
  const url = p(frame, T.wordmark + 3, 14);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
      <CloudFilter id="clouds-sky" />
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${-lift}px)` }}>
        <div style={{ position: "absolute", inset: 0, background: SKY_GRADIENT }} />
        {/* Below the sky: white that thins out over 360px, so the page beneath is uncovered softly. */}
        <div style={{ position: "absolute", left: 0, width: W, top: H - 1, height: 360, background: "linear-gradient(180deg, #FFFFFF 0%, #FFFFFF 30%, rgb(255 255 255 / 0))" }} />
        {/* Faint grid: content edges and the safe lines, hollow nodes at the crossings. */}
        <Frame color="rgb(255 255 255 / 0.16)" node="rgb(255 255 255 / 0.32)" fill="transparent" opacity={grid} />
        {/* Darker ellipse behind the copy keeps white type ≥ AA on the brightest blue (tokens --sky-scrim). */}
        <div
          style={{
            position: "absolute",
            left: W / 2 - 900,
            top: opening ? 150 : 110,
            width: 1800,
            height: opening ? 560 : 600,
            background: `radial-gradient(closest-side, ${C.skyScrim} 0%, ${C.skyScrim} 50%, transparent)`,
            opacity: opening ? 0.7 : mix(orbit, 0, 0.75),
          }}
        />
        {opening ? (
          <>
            <div style={{ position: "absolute", left: 160, top: 122, color: "#FFFFFF", ...display, fontSize: 48, opacity: grid }}>Notary</div>
            <div style={{ position: "absolute", left: 0, right: 0, top: 262, textAlign: "center", color: "#FFFFFF", ...display, fontSize: 176 }}>
              <RisingWords
                start={T.headline}
                size={176}
                lines={[
                  [{ text: "No" }, { text: "certificate," }],
                  [{ text: "no" }, { text: "money" }, { text: "moves", italic: true, suffix: "." }],
                ]}
              />
            </div>
          </>
        ) : (
          <>
            <Orbits draw={orbit} nodes={nodes} cy={432} />
            <div style={{ position: "absolute", left: 0, right: 0, top: 300, textAlign: "center", color: "#FFFFFF", ...display, fontSize: 140 }}>
              <RisingWords start={T.closeTitle} size={140} lines={[[{ text: "Let" }, { text: "your" }, { text: "agent" }, { text: "prove" }, { text: "it" }, { text: "first." }]]} />
            </div>
            <div style={{ position: "absolute", left: 0, right: 0, top: 492, textAlign: "center", color: "#FFFFFF", ...display, fontSize: 72, opacity: mark, transform: `translateY(${(1 - mark) * 16}px)` }}>
              Notary
            </div>
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 588,
                textAlign: "center",
                color: "rgb(255 255 255 / 0.92)",
                fontFamily: SANS,
                fontSize: 28,
                fontWeight: 500,
                letterSpacing: "0.01em",
                opacity: url,
                transform: `translateY(${(1 - url) * 12}px)`,
              }}
            >
              {github}
            </div>
          </>
        )}
      </div>
      <Clouds layer={BACK} filterId="clouds-sky" fieldHeight={500} fieldBottom={H} width={W} lift={lift} phase={260} />
      <Clouds layer={MID} filterId="clouds-sky" fieldHeight={500} fieldBottom={H} width={W} lift={lift} phase={90} />
      {/* The white the clouds melt into (landing .clouds-base), riding with the sky. */}
      <div style={{ position: "absolute", left: 0, width: W, top: H - 150 - lift, height: 151, background: "linear-gradient(180deg, rgb(255 255 255 / 0), #FFFFFF 70%)" }} />
    </div>
  );
}
