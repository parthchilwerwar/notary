// The neatHack submission video: a motion-graphic open, then one scene per voice section (problem,
// Notary, neatlogs, Entire, cfo.ai, close), each as long as its voice line. Every record on screen
// comes from src/explainer/assets.json (scripts/explainer-prep.ts); recordings of the real dashboard
// replace the rendered views as soon as the recording agent delivers them.
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import "../web";
import "../fonts";
import { C, SANS } from "../theme";
import { Captions } from "./Captions";
import { Sound } from "./Sound";
import { OVERLAP, SECTIONS, TOTAL, A } from "./timeline";
import { IntroSky } from "./scenes/Sky";
import { Problem } from "./scenes/Problem";
import { NotaryScene } from "./scenes/NotaryScene";
import { Neatlogs } from "./scenes/Neatlogs";
import { StackScene } from "./scenes/Stack";
import { ProgressBar } from "./kit";
import { P } from "./plan";
import { CfoScene, CloseScene, EntireScene } from "./scenes/Closing";

const SCENES = { intro: IntroSky, problem: Problem, notary: NotaryScene, stack: StackScene, neatlogs: Neatlogs, entire: EntireScene, cfo: CfoScene, close: CloseScene } as const;

/** Assets still missing (shown as a small corner badge in previews; the final render has none). */
export const PENDING = [
  ...SECTIONS.filter((s) => s.placeholder).map((s) => `voice:${s.id}`),
  ...Object.entries(A.clips)
    .filter(([, c]) => c.status !== "real")
    .map(([id]) => `clip:${id}`),
];

export function Explainer({ showPending = false }: { showPending?: boolean }) {
  const frame = useCurrentFrame();
  const intro = SECTIONS[0]!;
  const close = SECTIONS.at(-1)!;
  const onSky = frame < intro.from + intro.dur - 20 || frame >= close.from + P.close.sky + 16;
  return (
    <AbsoluteFill style={{ background: C.page, overflow: "hidden" }}>
      {SECTIONS.map((s, i) => {
        const Scene = SCENES[s.id];
        const last = i === SECTIONS.length - 1;
        return (
          <Sequence key={s.id} from={s.from} durationInFrames={last ? s.dur : Math.min(s.dur + OVERLAP, TOTAL - s.from)} name={s.id}>
            <Scene />
          </Sequence>
        );
      })}
      <ProgressBar frame={frame} onSky={onSky} />
      <Captions />
      <Sound />
      {showPending && PENDING.length > 0 && (
        <div style={{ position: "absolute", right: 16, top: 12, padding: "4px 10px", borderRadius: 8, background: "rgb(220 38 38 / 0.85)", color: "#fff", fontFamily: SANS, fontSize: 13 }}>
          placeholder: {PENDING.join(", ")}
        </div>
      )}
    </AbsoluteFill>
  );
}
