// The film's sound: the synthesized music bed (public/audio/music.wav, ducked slightly under every
// cue) and each sound effect placed frame-accurately from the cue sheet (cues.ts). All WAVs are
// rendered by scripts/audio.ts from code; nothing is downloaded.
import { Audio, Sequence, staticFile } from "remotion";
import type { ShowreelData } from "../data-schema";
import { cues, duck } from "./cues";
import { MUSIC_GAIN, SFX_GAIN } from "./gains";

export function Soundtrack({ data }: { data: ShowreelData }) {
  const all = cues(data);
  return (
    <>
      <Audio src={staticFile("audio/music.wav")} volume={(f) => MUSIC_GAIN * duck(f, all)} />
      {all.map((c, i) => (
        <Sequence key={`${c.frame}-${c.sfx}-${i}`} from={c.frame} durationInFrames={45} layout="none" name={c.label}>
          <Audio src={staticFile(`audio/${c.sfx}.wav`)} volume={c.gain * SFX_GAIN} />
        </Sequence>
      ))}
    </>
  );
}
