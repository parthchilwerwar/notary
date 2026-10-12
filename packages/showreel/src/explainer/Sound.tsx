// The Explainer's sound: each section's voice line, the synthesized music bed ducked −12 dB under
// speech, and the effects from the cue sheet. Voice WAVs and the music are written (and loudness-
// checked) by scripts/explainer-audio.ts into public/explainer/audio; until then the delivered mp3s play.
import { Audio, Sequence, staticFile } from "remotion";
import mix from "./mix.json";
import { musicGainAt, speechEnvelope, xcues } from "./cues";
import { SECTIONS } from "./timeline";

const ENV = speechEnvelope();
const CUES = xcues();
type Mix = { ready: boolean; voice: Record<string, string>; music: string | null; musicGain: number; sfxGain: number };
const M = mix as Mix;

export function Sound() {
  return (
    <>
      {SECTIONS.map((s) => {
        const src = (M.ready && M.voice[s.id]) || s.voiceSrc;
        if (!src) return null;
        return (
          <Sequence key={s.id} from={s.from + s.voiceAt} layout="none" name={`voice ${s.id}`}>
            <Audio src={staticFile(src)} />
          </Sequence>
        );
      })}
      {M.ready && M.music && <Audio src={staticFile(M.music)} volume={(f) => Math.min(1, M.musicGain * musicGainAt(ENV, f))} />}
      {M.ready &&
        CUES.map((c, i) => (
          <Sequence key={`${c.frame}-${c.sfx}-${i}`} from={c.frame} durationInFrames={45} layout="none" name={c.label}>
            <Audio src={staticFile(`explainer/audio/${c.sfx}.wav`)} volume={Math.min(1, c.gain * M.sfxGain)} />
          </Sequence>
        ))}
    </>
  );
}
