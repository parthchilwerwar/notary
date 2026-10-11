// Shared render plumbing: one webpack bundle of src/index.ts and the system Google Chrome
// (never a downloaded Chrome Headless Shell). Remotion's own ffmpeg (in its compositor package)
// does the encoding.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, selectComposition } from "@remotion/renderer";
import { makeWebpackOverride } from "../src/webpack-override";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");
export const OUT = resolve(ROOT, "out");

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

/** The installed Google Chrome. Throws (rather than downloading a browser) when none is found. */
export function systemChrome(): string {
  const found = CANDIDATES.find((p): p is string => !!p && existsSync(p));
  if (!found) throw new Error("Google Chrome not found. Set CHROME_PATH to chrome.exe; this project never downloads a browser.");
  return found;
}

export async function setup(compositionId: string) {
  const browserExecutable = systemChrome();
  console.log(`bundling src/index.ts …`);
  const serveUrl = await bundle({ entryPoint: resolve(ROOT, "src/index.ts"), webpackOverride: makeWebpackOverride(ROOT), publicDir: resolve(ROOT, "public") });
  // System Chrome only supports the new headless mode, which Remotion uses in chrome-for-testing mode.
  const browser = await openBrowser("chrome", { browserExecutable, chromeMode: "chrome-for-testing" });
  const composition = await selectComposition({ serveUrl, id: compositionId, puppeteerInstance: browser, browserExecutable, chromeMode: "chrome-for-testing" });
  return { serveUrl, browser, browserExecutable, composition };
}

/** Remotion's bundled ffmpeg / ffprobe (the compositor package of @remotion/renderer, per platform). */
export function remotionBinary(name: "ffmpeg" | "ffprobe"): string {
  const req = createRequire(join(ROOT, "node_modules/@remotion/renderer/package.json"));
  const arch = process.platform === "win32" ? "win32-x64-msvc" : process.platform === "darwin" ? `darwin-${process.arch}` : `linux-${process.arch}-gnu`;
  const dir = dirname(req.resolve(`@remotion/compositor-${arch}/package.json`));
  return join(dir, process.platform === "win32" ? `${name}.exe` : name);
}

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) for the stills checks: returns RGB bytes. */
export function decodePng(buf: Buffer): { width: number; height: number; rgb: Uint8Array } {
  let o = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("decodePng: only 8-bit, non-interlaced");
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!channels) throw new Error("decodePng: only RGB/RGBA");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels]! : 0;
      const v = raw[src + x]!;
      let r: number;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + x] = r & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < px.length; i += channels, j += 3) {
    rgb[j] = px[i]!;
    rgb[j + 1] = px[i + 1]!;
    rgb[j + 2] = px[i + 2]!;
  }
  return { width, height, rgb };
}
