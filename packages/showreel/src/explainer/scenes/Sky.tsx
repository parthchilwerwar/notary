// The opening and closing sky (the v2 showreel's hero: gradient, three cloud layers, the faint grid),
// with the headline revealed word by word exactly when the voice says each word. `lift` moves the
// sky up (the camera diving through the clouds onto the white page) or, reversed, brings it back.
import { useCurrentFrame } from "remotion";
import { BACK, CloudFilter, Clouds, FRONT, MID } from "../../components/Clouds";
import { Frame } from "../../components/Frame";
import { C, CAMERA, SANS, SKY_GRADIENT, display, p } from "../../theme";
import { P } from "../plan";
import { section, type TimedWord } from "../timeline";
import { H, W } from "../kit";

const TRAVEL = 1460;

function SkyBackdrop({ lift, grid, scrim }: { lift: number; grid: number; scrim: number }) {
  return (
    <>
      <CloudFilter id="x-clouds-sky" />
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${-lift}px)` }}>
        <div style={{ position: "absolute", inset: 0, background: SKY_GRADIENT }} />
        <div style={{ position: "absolute", left: 0, width: W, top: H - 1, height: 360, background: "linear-gradient(180deg, #FFFFFF 0%, #FFFFFF 30%, rgb(255 255 255 / 0))" }} />
        <Frame color="rgb(255 255 255 / 0.16)" node="rgb(255 255 255 / 0.32)" fill="transparent" opacity={grid} />
        <div style={{ position: "absolute", left: W / 2 - 900, top: 130, width: 1800, height: 620, background: `radial-gradient(closest-side, ${C.skyScrim} 0%, ${C.skyScrim} 50%, transparent)`, opacity: 0.7 * scrim }} />
      </div>
      <Clouds layer={BACK} filterId="x-clouds-sky" fieldHeight={500} fieldBottom={H} width={W} lift={lift} phase={260} />
      <Clouds layer={MID} filterId="x-clouds-sky" fieldHeight={500} fieldBottom={H} width={W} lift={lift} phase={90} />
      <div style={{ position: "absolute", left: 0, width: W, top: H - 150 - lift, height: 151, background: "linear-gradient(180deg, rgb(255 255 255 / 0), #FFFFFF 70%)" }} />
    </>
  );
}

function FrontClouds({ lift }: { lift: number }) {
  return (
    <>
      <CloudFilter id="x-clouds-front" scale={72} />
      <Clouds layer={FRONT} filterId="x-clouds-front" fieldHeight={500} fieldBottom={1080} width={1920} lift={lift} phase={420} />
    </>
  );
}

/** The headline's words, each rising in at the frame its spoken word starts. */
function SpokenHeadline({ words, top, size }: { words: { text: string; italic?: boolean; at: number; br?: boolean }[]; top: number; size: number }) {
  const frame = useCurrentFrame();
  const lines: (typeof words)[] = [[]];
  for (const w of words) {
    lines.at(-1)!.push(w);
    if (w.br) lines.push([]);
  }
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top, textAlign: "center", color: "#FFFFFF", ...display, fontSize: size }}>
      {lines.map((line, li) => (
        <div key={li} style={{ whiteSpace: "nowrap" }}>
          {line.map((w, wi) => {
            const t = p(frame, w.at - 3, 14);
            return (
              <span key={wi} style={{ display: "inline-block", opacity: t, transform: `translateY(${(1 - t) * 28}px)`, marginRight: wi < line.length - 1 ? size * 0.22 : 0, fontStyle: w.italic ? "italic" : "normal" }}>
                {w.text}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** "No certificate, / no money moves." from the last six spoken words of a section's line. */
function headlineWords(words: TimedWord[], fromIndex: number) {
  const w = words.slice(fromIndex, fromIndex + 5);
  const clean = (s: string) => s.replace(/\.$/, "");
  return [
    { text: clean(w[0]!.text), at: w[0]!.from },
    { text: clean(w[1]!.text), at: w[1]!.from, br: true },
    { text: clean(w[2]!.text), at: w[2]!.from },
    { text: clean(w[3]!.text), at: w[3]!.from },
    { text: `${clean(w[4]!.text)}.`, at: w[4]!.from, italic: true },
  ];
}

export function IntroSky() {
  const frame = useCurrentFrame();
  const s = section("intro");
  const dive = p(frame, P.intro.dive, 34, CAMERA);
  const lift = dive * TRAVEL + Math.min(1, frame / P.intro.dive) * 18;
  const notaryIdx = s.words.findIndex((w) => w.norm === "notary");
  const mark = p(frame, P.intro.notary - 4, 16);
  return (
    <div style={{ position: "absolute", inset: 0, background: C.page, overflow: "hidden" }}>
      <SkyBackdrop lift={lift} grid={p(frame, 0, 24)} scrim={1} />
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${-lift}px)` }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 150, textAlign: "center", color: "#FFFFFF", ...display, fontSize: 64, opacity: mark, transform: `translateY(${(1 - mark) * 16}px)` }}>Notary</div>
        <SpokenHeadline top={262} size={168} words={headlineWords(s.words, notaryIdx + 1)} />
      </div>
      <FrontClouds lift={lift} />
    </div>
  );
}

export function CloseSky({ github, credit }: { github: string; credit: string }) {
  const frame = useCurrentFrame();
  const s = section("close");
  const start = P.close.sky;
  const rise = p(frame, start, 30, CAMERA);
  if (frame < start) return null;
  const lift = (1 - rise) * TRAVEL;
  const idx = s.words.findIndex((w, i) => w.norm === "notary" && i > s.words.length - 8);
  const mark = p(frame, P.close.notary - 2, 16);
  const url = p(frame, P.close.moves + 14, 16);
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <SkyBackdrop lift={lift} grid={rise} scrim={1} />
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${-lift}px)` }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 150, textAlign: "center", color: "#FFFFFF", ...display, fontSize: 64, opacity: mark, transform: `translateY(${(1 - mark) * 16}px)` }}>Notary</div>
        <SpokenHeadline top={262} size={168} words={headlineWords(s.words, idx + 1)} />
        <div style={{ position: "absolute", left: 0, right: 0, top: 678, textAlign: "center", color: "rgb(255 255 255 / 0.95)", fontFamily: SANS, fontSize: 30, fontWeight: 500, letterSpacing: "0.01em", opacity: url, transform: `translateY(${(1 - url) * 12}px)` }}>
          {github}
        </div>
      </div>
      <FrontClouds lift={lift} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 34, textAlign: "center", fontFamily: SANS, fontSize: 17, fontWeight: 500, color: C.muted, opacity: url }}>{credit}</div>
    </div>
  );
}
