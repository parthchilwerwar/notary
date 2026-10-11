// Screenshots for docs/screenshots/ (K4 visual loop): the landing (full length) and every dashboard
// page at 1440 and 390 px in the light theme, plus the dashboard at 1440 in the dark theme. Chat is
// captured mid-answer in replay (a question sent, steps streaming and expanded) by pausing the page
// clock between events. Runs against a production build served by `vite preview` (replay mode).
//   NOTARY_PREVIEW_URL  base URL (default http://127.0.0.1:5175)
//   NOTARY_SCREENSHOTS  output dir (default ../../docs/screenshots)
// Uses the system Chrome (channel "chrome"); no browser download.
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? fileURLToPath(new URL("../../../docs/screenshots", import.meta.url)));
await mkdir(out, { recursive: true });

const json = async (path) => JSON.parse(await readFile(new URL(`../public/${path}`, import.meta.url), "utf8"));
const guarded = await json("bundles/fixture/demo-run-guarded.json");
const notarize = await json("bundles/fixture/demo-notarize-dodo.json");
const certs = await json("certificates/fixture/default/dodo.json");
const q = (run) => `?run=${encodeURIComponent(run)}`;
// The certificate with the most evidence (the record links come from the published data).
const cert = [...certs.certificates].sort((a, b) => b.evidence.length - a.evidence.length)[0];

const pages = [
  { slug: "run", path: `/app/run${q(guarded.runId)}`, h1: "Run" },
  { slug: "certificates", path: `/app/certificates${q(notarize.runId)}`, h1: "Certificates" },
  { slug: "certificate", path: `/app/certificates/${encodeURIComponent(cert.id)}${q(notarize.runId)}`, h1: cert.claimId },
  { slug: "approvals", path: `/app/approvals${q(guarded.runId)}`, h1: "Approvals" },
  { slug: "report", path: `/app/report${q(guarded.runId)}`, h1: "Report" },
];
// `frames: false` on a page whose clock is paused (its requestAnimationFrame is paused too).
const settle = (page, frames = true) =>
  page.evaluate(async (f) => {
    await document.fonts.ready;
    if (f) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, frames);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const written = [];
const shoot = async (page, name, { frames = true, ...opts } = {}) => {
  await settle(page, frames);
  const extra = await overflow(page);
  if (extra > 0) throw new Error(`${name}: horizontal overflow of ${extra}px`);
  const path = resolve(out, `${name}.png`);
  await page.screenshot({ path, animations: "disabled", ...opts });
  written.push(`${name}.png`);
};

try {
  for (const [width, theme] of [
    [1440, "light"],
    [390, "light"],
    [1440, "dark"],
  ]) {
    const suffix = theme === "dark" ? `${width}-dark` : `${width}`;
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 }, reducedMotion: "reduce" });
    await context.addInitScript((t) => localStorage.setItem("notary-theme", t), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // The landing is pinned to the light theme; one full-length capture per width.
    if (theme === "light") {
      await page.goto(`${base}/`);
      // Scroll through once so every lazy section and its data load, then return to the top.
      await page.evaluate(async () => {
        await document.fonts.ready;
        for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
          scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
      });
      await page.locator(".l-mini-held .l-mini-actions").first().waitFor({ state: "attached", timeout: 30000 });
      await page.waitForTimeout(800);
      await page.evaluate(() => scrollTo(0, 0));
      await shoot(page, `landing-${suffix}`, { fullPage: true });
    }

    for (const p of pages) {
      await page.goto(`${base}${p.path}`);
      await expect(page.getByRole("heading", { level: 1, name: p.h1, exact: true })).toBeVisible({ timeout: 30000 });
      await page.waitForLoadState("networkidle");
      // The Run page replays the recorded timeline at 1x; show the whole run instead of a moment of it.
      if (p.slug === "run") {
        await page.getByRole("button", { name: "Instant" }).click();
        await expect(page.locator(".run-waiting")).toHaveCount(0, { timeout: 30000 });
      }
      await shoot(page, `${p.slug}-${suffix}`, { fullPage: true });
    }

    // Chat mid-answer: send a question in replay, then advance a paused page clock (fresh tab) until
    // the steps have streamed and the answer is part-written, with the steps expanded.
    const chatContext = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 }, reducedMotion: "reduce" });
    await chatContext.addInitScript((t) => localStorage.setItem("notary-theme", t), theme);
    const chat = await chatContext.newPage();
    chat.on("pageerror", (e) => errors.push(e.message));
    await chat.clock.install();
    await chat.goto(`${base}/app/chat${q(guarded.runId)}`);
    await expect(chat.getByRole("heading", { level: 1, name: "Notary Chat", exact: true })).toBeVisible({ timeout: 30000 });
    await chat.waitForLoadState("networkidle");
    await chat.clock.pauseAt(Date.now() + 1000);
    await chat.getByRole("textbox", { name: "Message Notary" }).fill("Why was refund q02 held?");
    await chat.keyboard.press("Enter");
    let state = { steps: 0, text: 0, footer: false };
    for (let i = 0; i < 200 && !(state.steps >= 3 && state.text > 900); i++) {
      await chat.clock.runFor(20);
      state = await chat.evaluate(() => ({
        steps: document.querySelectorAll(".chat-steps > *").length,
        text: document.querySelector(".chat-msg-assistant")?.textContent?.length ?? 0,
        footer: !!document.querySelector(".chat-footer"),
      }));
    }
    if (state.footer || state.steps < 3) throw new Error(`chat: not captured mid-answer (${JSON.stringify(state)})`);
    if (!(await chat.locator(".chat-work").first().getAttribute("data-open"))) await chat.locator(".chat-work-toggle").first().click();
    await shoot(chat, `chat-${suffix}`, { frames: false });
    await chatContext.close();

    if (errors.length) throw new Error(`${width} ${theme}: ${errors.join("; ")}`);
    await context.close();
  }
  console.log(`Wrote ${written.length} screenshots to ${out}:\n  ${written.join("\n  ")}`);
} finally {
  await browser.close();
}
