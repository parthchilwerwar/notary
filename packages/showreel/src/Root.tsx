import { Composition } from "remotion";
import raw from "./data.json";
import { ShowreelDataSchema } from "./data-schema";
import { Probe } from "./Probe";
import { Film } from "./v2/Film";
import { DURATION, FPS } from "./v2/timeline";

// data.json is validated before anything renders: a missing or malformed value fails here.
const data = ShowreelDataSchema.parse(raw);

export function RemotionRoot() {
  return (
    <>
      <Composition id="Showreel" component={Film} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} defaultProps={data} />
      <Composition id="Probe" component={Probe} durationInFrames={1} fps={FPS} width={1920} height={1080} defaultProps={data} />
    </>
  );
}
