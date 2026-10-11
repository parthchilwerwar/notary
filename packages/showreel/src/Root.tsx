import { Composition } from "remotion";
import raw from "./data.json";
import { ShowreelDataSchema } from "./data-schema";
import { Showreel } from "./Showreel";
import { DURATION, FPS } from "./timeline";

// data.json is validated before anything renders: a missing or malformed value fails here.
const data = ShowreelDataSchema.parse(raw);

export function RemotionRoot() {
  return (
    <>
      <Composition id="Showreel" component={Showreel} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} defaultProps={data} />
    </>
  );
}
