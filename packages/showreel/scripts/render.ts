// Renders the film (H.264 MP4) and its poster frame, then copies them to docs/media/.
//   pnpm --filter @notary/showreel render
// Run `pnpm --filter @notary/showreel props` first whenever the published records change.
import { copyFile, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { renderMedia, renderStill } from "@remotion/renderer";
import { generateAudio } from "./audio";
import { OUT, ROOT, setup } from "./lib";

const MEDIA = resolve(ROOT, "../../docs/media");

const mb = async (p: string) => `${((await stat(p)).size / 1024 / 1024).toFixed(2)} MB`;

// The synthesized music and effects (deterministic) are written to public/audio first.
await generateAudio();
const { serveUrl, browser, browserExecutable, composition } = await setup("Showreel");
await mkdir(OUT, { recursive: true });
await mkdir(MEDIA, { recursive: true });

async function film(id: string, file: string) {
  const comp = composition;
  const output = resolve(OUT, file);
  const started = Date.now();
  let last = -1;
  await renderMedia({
    serveUrl,
    composition: comp,
    codec: "h264",
    audioCodec: "aac",
    audioBitrate: "192k",
    crf: 20,
    x264Preset: "slow",
    pixelFormat: "yuv420p",
    colorSpace: "bt709",
    outputLocation: output,
    puppeteerInstance: browser,
    browserExecutable,
    chromeMode: "chrome-for-testing",
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 10) * 10;
      if (pct !== last) {
        last = pct;
        process.stdout.write(`${id} ${pct}%\n`);
      }
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  await copyFile(output, resolve(MEDIA, file));
  console.log(`${id}: ${output} (${await mb(output)}, rendered in ${seconds} s) → docs/media/${file}`);
  return comp;
}

await film("Showreel", "notary-showreel.mp4");

// Poster: the final, settled frame.
const poster = resolve(OUT, "notary-showreel-poster.png");
await renderStill({ serveUrl, composition, frame: composition.durationInFrames - 1, output: poster, imageFormat: "png", puppeteerInstance: browser, browserExecutable, chromeMode: "chrome-for-testing" });
await copyFile(poster, resolve(MEDIA, "notary-showreel-poster.png"));
console.log(`poster: ${poster} (${await mb(poster)}) → docs/media/notary-showreel-poster.png`);

await browser.close({ silent: true });
