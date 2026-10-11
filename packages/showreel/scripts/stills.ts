// Renders stills of the film to out/stills/ for review.
//   pnpm --filter @notary/showreel still                 every 15 frames (0.5 s)
//   pnpm --filter @notary/showreel still 120 180 240     those frames
//   pnpm --filter @notary/showreel still --id <CompositionId> 120
//   pnpm --filter @notary/showreel still --check-chart   every frame of the chart morph: fails if a
//                                                         frame shows "With Notary" next to red unsafe pixels
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderStill } from "@remotion/renderer";
import { chartState } from "../src/v2/chart-state";
import { V } from "../src/v2/timeline";
import { decodePng, OUT, setup } from "./lib";

const args = process.argv.slice(2);
const checkChart = args.includes("--check-chart");
const idAt = args.indexOf("--id");
const id = idAt >= 0 ? args[idAt + 1]! : "Showreel";
const nums = args.filter((_, i) => idAt < 0 || (i !== idAt && i !== idAt + 1)).map(Number).filter((n) => Number.isFinite(n));

const { serveUrl, browser, browserExecutable, composition } = await setup(id);
const morph = Array.from({ length: V.enforceOut + 8 - V.chartIn + 1 }, (_, i) => V.chartIn + i);
const frames = checkChart ? morph : nums.length ? nums : Array.from({ length: Math.floor(composition.durationInFrames / 15) }, (_, i) => i * 15).concat(composition.durationInFrames - 1);
const dir = resolve(OUT, "stills");
await mkdir(dir, { recursive: true });
for (const frame of frames) {
  const output = resolve(dir, `${id === "Showreel" ? "" : `${id}-`}f${String(frame).padStart(3, "0")}.png`);
  await renderStill({ serveUrl, composition, frame, output, puppeteerInstance: browser, browserExecutable, chromeMode: "chrome-for-testing", imageFormat: "png" });
  console.log(output);
}
await browser.close({ silent: true });

if (checkChart) {
  // Red unsafe pixels (#DC2626 family) inside the chart's plot area, from the rendered PNG.
  const W = 1920;
  const box = { x0: 1290, x1: 1880, y0: 405, y1: 740 };
  let failures = 0;
  for (const frame of frames) {
    const png = resolve(dir, `f${String(frame).padStart(3, "0")}.png`);
    const { rgb } = decodePng(await readFile(png));
    let red = 0;
    for (let y = box.y0; y < box.y1; y++)
      for (let x = box.x0; x < box.x1; x++) {
        const i = (y * W + x) * 3;
        if (rgb[i]! > 170 && rgb[i + 1]! < 90 && rgb[i + 2]! < 90) red++;
      }
    const s = chartState(frame);
    const label = s.withLabel > 0 ? "With Notary" : "Without Notary";
    const bad = s.withLabel > 0 && red > 0;
    if (bad) failures++;
    console.log(`f${frame}: label ${label} (${s.withLabel.toFixed(2)}), dissolve ${s.dissolve.toFixed(2)}, red pixels ${red}${bad ? "  <-- FAIL" : ""}`);
  }
  if (failures) throw new Error(`${failures} frame(s) pair "With Notary" with red unsafe pixels`);
  console.log("chart check: no frame pairs \"With Notary\" with red unsafe pixels");
}
