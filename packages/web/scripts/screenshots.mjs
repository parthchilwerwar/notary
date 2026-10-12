// Screenshots for docs/screenshots/ (visual loop): the landing and the guide (full length) and every
// dashboard page at 1440 and 390 px, for the default view (REAL runs only — no ?run= in the URL; the
// app picks the default run and writes ?run= itself), plus a fixture pass of the dashboard pages
// (?fixtures=1 with a fixture run, under the "Fixture data" disclosure). The app is light only.
// Chat is captured mid-answer in replay (a question sent, steps streaming and expanded) by pausing
// the page clock between events. Runs against a production build served by `vite preview`.
//   NOTARY_PREVIEW_URL  base URL (default http://127.0.0.1:5175)
//   NOTARY_SCREENSHOTS  output dir (default ../../docs/screenshots)
//   NOTARY_OG_IMAGE     social preview image (default ../public/og.png, referenced by index.html):
//                       the top of the landing at 1200×630, refreshed on every run
// File names: <page>-<width>.png (real runs), <page>-<width>-fixture.png (fixture view).
// Uses the system Chrome (channel "chrome"); no browser download.
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? fileURLToPath(new URL("../../../docs/screenshots", import.meta.url)));
await mkdir(out, { recursive: true });
const ogImage = resolve(process.env.NOTARY_OG_IMAGE ?? fileURLToPath(new URL("../public/og.png", import.meta.url)));

const json = async (path) => JSON.parse(await readFile(new URL(`../public/${path}`, import.meta.url), "utf8"));
const optional = (path, fallback) => json(path).catch(() => fallback);
const enc = encodeURIComponent;
const FIXTURE_BANNER = "Fixture data — simulated APIs, not a live run"; // src/data/types.ts

// Record links come from the published data; nothing is invented.
const realRuns = (await optional("bundles/index.json", [])).filter((e) => !e.sample);
if (!realRuns.length) throw new Error("No real runs in public/bundles/index.json: nothing to capture in the default view.");
const guarded = await json("bundles/fixture/demo-run-guarded.json");
const notarize = await json("bundles/fixture/demo-notarize-dodo.json");
const fixtureCerts = (await json("certificates/fixture/default/dodo.json")).certificates;
const realCerts = [
  ...(await optional("certificates/dodo.json", { certificates: [] })).certificates,
  ...(await optional("certificates/crustdata.json", { certificates: [] })).certificates,
];
// The certificate with the most evidence.
const mostEvidence = (list) => [...list].sort((a, b) => (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0))[0];
const realCert = mostEvidence(realCerts);
const fixtureCert = mostEvidence(fixtureCerts);
const fx = (run, extra = "") => `?run=${enc(run)}&fixtures=1${extra}`;

const views = [
  {
    view: "real",
    suffix: "",
    pages: [
      { slug: "run", path: "/app/run?speed=instant", h1: "Run" },
      { slug: "certificates", path: "/app/certificates", h1: "Certificates" },
      ...(realCert ? [{ slug: "certificate", path: `/app/certificates/${enc(realCert.id)}`, h1: realCert.claimId }] : []),
      { slug: "approvals", path: "/app/approvals", h1: "Approvals" },
      { slug: "business", path: "/app/business", h1: "Business" },
      { slug: "incidents", path: "/app/incidents", h1: "Incidents" },
      { slug: "report", path: "/app/report", h1: "Report" },
    ],
    chat: { path: "/app/chat", question: "Which certificates are active?" },
  },
  {
    view: "fixture",
    suffix: "-fixture",
    pages: [
      { slug: "run", path: `/app/run${fx(guarded.runId, "&speed=instant")}`, h1: "Run" },
      { slug: "certificates", path: `/app/certificates${fx(notarize.runId)}`, h1: "Certificates" },
      { slug: "certificate", path: `/app/certificates/${enc(fixtureCert.id)}${fx(notarize.runId)}`, h1: fixtureCert.claimId },
      { slug: "approvals", path: `/app/approvals${fx(guarded.runId)}`, h1: "Approvals" },
      // Business shows real data only (no fixture economics exist); its fixture capture would repeat the real one.
      { slug: "incidents", path: `/app/incidents${fx(guarded.runId)}`, h1: "Incidents" },
      { slug: "report", path: `/app/report${fx(guarded.runId)}`, h1: "Report" },
    ],
    chat: { path: `/app/chat${fx(guarded.runId)}`, question: "Why was refund q02 held?" },
  },
];

// `frames: false` on a page whose clock is paused (its requestAnimationFrame is paused too).
const settle = (page, frames = true) =>
  page.evaluate(async (f) => {
    await document.fonts.ready;
    if (f) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, frames);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const viewport = (width) => ({ width, height: width === 1440 ? 900 : 844 });

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
  // The social preview (og:image / twitter:image): the landing's first screen at 1200×630.
  {
    const ogContext = await browser.newContext({ viewport: { width: 1200, height: 630 }, reducedMotion: "reduce" });
    const og = await ogContext.newPage();
    await og.goto(`${base}/`);
    await expect(og.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30000 });
    await og.waitForLoadState("networkidle");
    await settle(og);
    await og.screenshot({ path: ogImage, animations: "disabled" });
    written.push(ogImage);
    await ogContext.close();
  }

  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: viewport(width), reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // The landing, full length: scroll through once so every lazy section and its data load.
    await page.goto(`${base}/`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
    });
    await expect(page.locator(".l-mini-pending")).toHaveCount(0, { timeout: 30000 });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    await page.evaluate(() => scrollTo(0, 0));
    await shoot(page, `landing-${width}`, { fullPage: true });

    // The guide, full length.
    await page.goto(`${base}/docs`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30000 });
    await page.waitForLoadState("networkidle");
    await shoot(page, `docs-${width}`, { fullPage: true });

    for (const { view, suffix, pages, chat: chatPage } of views) {
      for (const p of pages) {
        await page.goto(`${base}${p.path}`);
        await expect(page.getByRole("heading", { level: 1, name: p.h1, exact: true })).toBeVisible({ timeout: 30000 });
        await page.waitForLoadState("networkidle");
        // Fixture data always carries the disclosure; the default view never shows fixture data.
        const banner = page.getByText(FIXTURE_BANNER, { exact: true });
        if (view === "fixture") await expect(banner.first()).toBeVisible();
        else await expect(banner).toHaveCount(0);
        // The Run page replays the recorded timeline (?speed=instant); show the whole run.
        if (p.slug === "run") await expect(page.locator(".run-status")).toContainText(/finished|stream ended/, { timeout: 30000 });
        await shoot(page, `${p.slug}-${width}${suffix}`, { fullPage: true });
      }

      // Chat mid-answer: send a question in replay, then advance a paused page clock (fresh tab)
      // until the steps have streamed and the answer is part-written, with the steps expanded.
      const chatContext = await browser.newContext({ viewport: viewport(width), reducedMotion: "reduce" });
      const chat = await chatContext.newPage();
      chat.on("pageerror", (e) => errors.push(e.message));
      await chat.clock.install();
      await chat.goto(`${base}${chatPage.path}`);
      await expect(chat.getByRole("heading", { level: 1, name: "Notary Chat", exact: true })).toBeVisible({ timeout: 30000 });
      await chat.waitForLoadState("networkidle");
      await chat.clock.pauseAt(Date.now() + 1000);
      await chat.getByRole("textbox", { name: "Message Notary" }).fill(chatPage.question);
      await chat.keyboard.press("Enter");
      let state = { steps: 0, text: 0, footer: false };
      for (let i = 0; i < 200 && !(state.steps >= 2 && state.text > 400); i++) {
        await chat.clock.runFor(20);
        state = await chat.evaluate(() => ({
          steps: Number(document.querySelector('[data-slot="reasoning-steps"]')?.getAttribute("data-stage-count") ?? 0),
          text: document.querySelector(".chat-msg-assistant")?.textContent?.length ?? 0,
          footer: !!document.querySelector(".chat-footer"),
        }));
      }
      if (state.footer || state.steps < 2) throw new Error(`chat (${view}): not captured mid-answer (${JSON.stringify(state)})`);
      if (!(await chat.locator('[data-slot="reasoning-steps"]').first().getAttribute("data-open")))
        await chat.locator('[data-slot="reasoning-steps-header"]').first().click();
      await shoot(chat, `chat-${width}${suffix}`, { frames: false });
      await chatContext.close();
    }

    if (errors.length) throw new Error(`${width}: ${errors.join("; ")}`);
    await context.close();
  }
  console.log(`Wrote ${written.length} screenshots to ${out}:\n  ${written.join("\n  ")}`);
} finally {
  await browser.close();
}
