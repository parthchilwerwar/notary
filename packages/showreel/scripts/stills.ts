// Renders stills of the film to out/stills/ for review.
//   pnpm --filter @notary/showreel still                 every 15 frames (0.5 s)
//   pnpm --filter @notary/showreel still 120 180 240     those frames
//   pnpm --filter @notary/showreel still --id <CompositionId> 120
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { renderStill } from "@remotion/renderer";
import { OUT, setup } from "./lib";

const args = process.argv.slice(2);
const idAt = args.indexOf("--id");
const id = idAt >= 0 ? args[idAt + 1]! : "Showreel";
const nums = args.filter((_, i) => idAt < 0 || (i !== idAt && i !== idAt + 1)).map(Number).filter((n) => Number.isFinite(n));

const { serveUrl, browser, browserExecutable, composition } = await setup(id);
const frames = nums.length ? nums : Array.from({ length: Math.floor(composition.durationInFrames / 15) }, (_, i) => i * 15).concat(composition.durationInFrames - 1);
const dir = resolve(OUT, "stills");
await mkdir(dir, { recursive: true });
for (const frame of frames) {
  const output = resolve(dir, `${id === "Showreel" ? "" : `${id}-`}f${String(frame).padStart(3, "0")}.png`);
  await renderStill({ serveUrl, composition, frame, output, puppeteerInstance: browser, browserExecutable, chromeMode: "chrome-for-testing", imageFormat: "png" });
  console.log(output);
}
await browser.close({ silent: true });
