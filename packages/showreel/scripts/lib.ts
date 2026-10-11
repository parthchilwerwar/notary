// Shared render plumbing: one webpack bundle of src/index.ts and the system Google Chrome
// (never a downloaded Chrome Headless Shell). Remotion's own ffmpeg (in its compositor package)
// does the encoding.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, selectComposition } from "@remotion/renderer";

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
  const serveUrl = await bundle({ entryPoint: resolve(ROOT, "src/index.ts") });
  // System Chrome only supports the new headless mode, which Remotion uses in chrome-for-testing mode.
  const browser = await openBrowser("chrome", { browserExecutable, chromeMode: "chrome-for-testing" });
  const composition = await selectComposition({ serveUrl, id: compositionId, puppeteerInstance: browser, browserExecutable, chromeMode: "chrome-for-testing" });
  return { serveUrl, browser, browserExecutable, composition };
}
