// Renders the neatHack submission video (composition "Explainer") and everything that ships with it:
//   docs/media/notary-submission.mp4         H.264 + AAC, 1920×1080, 30 fps
//   docs/media/notary-submission-poster.png  the closing frame
//   docs/media/notary-submission.srt         captions (same pages as the burned-in ones)
//   out/explainer-contact.png                16-frame contact sheet for review
// Steps: gather assets (explainer-prep) → sound (explainer-audio) → render → poster → SRT → sheet.
//
//   pnpm --filter @notary/showreel explainer:render [--skip-audio]
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderMedia, renderStill } from "@remotion/renderer";
import { prepare, summary } from "./explainer-prep";
import { OUT, ROOT, setup } from "./lib";

const MEDIA = resolve(ROOT, "../../docs/media");
const mb = (p: string) => `${(statSync(p).size / 1024 / 1024).toFixed(2)} MB`;

const assets = prepare();
console.log(summary(assets));
if (!process.argv.includes("--skip-audio")) {
  const { generateExplainerAudio } = await import("./explainer-audio");
  await generateExplainerAudio();
}
// Timeline modules read assets.json at import: load them after prepare() wrote it.
const { srt, TOTAL, section } = await import("../src/explainer/timeline");
const { P } = await import("../src/explainer/plan");

mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });
const { serveUrl, browser, browserExecutable, composition } = await setup("Explainer");

const output = resolve(OUT, "notary-submission.mp4");
const started = Date.now();
let last = -1;
await renderMedia({
  serveUrl,
  composition,
  codec: "h264",
  audioCodec: "aac",
  audioBitrate: "192k",
  crf: 20,
  x264Preset: "medium",
  pixelFormat: "yuv420p",
  colorSpace: "bt709",
  outputLocation: output,
  puppeteerInstance: browser,
  browserExecutable,
  chromeMode: "chrome-for-testing",
  concurrency: 6,
  onProgress: ({ progress }) => {
    const pct = Math.floor(progress * 20) * 5;
    if (pct !== last) {
      last = pct;
      process.stdout.write(`Explainer ${pct}% (${((Date.now() - started) / 1000).toFixed(0)} s)\n`);
    }
  },
});
copyFileSync(output, join(MEDIA, "notary-submission.mp4"));
console.log(`video: docs/media/notary-submission.mp4 (${mb(output)}, ${TOTAL} frames, rendered in ${((Date.now() - started) / 1000).toFixed(0)} s)`);

// Poster: the closing sky once the URL is in.
const poster = resolve(OUT, "notary-submission-poster.png");
const posterFrame = Math.min(TOTAL - 1, section("close").from + P.close.moves + 45);
await renderStill({ serveUrl, composition, frame: posterFrame, output: poster, imageFormat: "png", puppeteerInstance: browser, browserExecutable, chromeMode: "chrome-for-testing" });
copyFileSync(poster, join(MEDIA, "notary-submission-poster.png"));
console.log(`poster: docs/media/notary-submission-poster.png (frame ${posterFrame}, ${mb(poster)})`);

writeFileSync(join(MEDIA, "notary-submission.srt"), srt());
console.log("captions: docs/media/notary-submission.srt");

// Contact sheet: 16 frames across the film, tiled 4×4 (PowerShell System.Drawing on Windows).
const sheetDir = resolve(OUT, "contact");
mkdirSync(sheetDir, { recursive: true });
const frames = Array.from({ length: 16 }, (_, i) => Math.round(((i + 0.5) / 16) * (TOTAL - 1)));
const files: string[] = [];
for (const f of frames) {
  const file = resolve(sheetDir, `f${String(f).padStart(5, "0")}.png`);
  await renderStill({ serveUrl, composition, frame: f, output: file, imageFormat: "png", puppeteerInstance: browser, browserExecutable, chromeMode: "chrome-for-testing", scale: 0.25 });
  files.push(file);
}
await browser.close({ silent: true });
if (process.platform === "win32") {
  const ps = `Add-Type -AssemblyName System.Drawing; $f = @(${files.map((f) => `'${f}'`).join(",")}); $b = New-Object System.Drawing.Bitmap 1920, 1080; $g = [System.Drawing.Graphics]::FromImage($b); for ($i = 0; $i -lt $f.Count; $i++) { $im = [System.Drawing.Image]::FromFile($f[$i]); $g.DrawImage($im, ($i % 4) * 480, [math]::Floor($i / 4) * 270, 480, 270); $im.Dispose() }; $b.Save('${resolve(OUT, "explainer-contact.png")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps]);
  console.log(`contact sheet: out/explainer-contact.png (frames ${frames.join(", ")})`);
}
