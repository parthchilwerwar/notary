// Mission control visual + behavior check against a running dev/preview server.
//   NOTARY_PREVIEW_URL  base URL (default http://127.0.0.1:5175)
//   NOTARY_SCREENSHOTS  output dir (default screenshots/V3; gitignored)
// Screens: two fixture runs × (1440 light, 390 dark) × (autoplay, mid-replay, stage filter,
// finished), reduced motion opening finished, a tampered timeline withheld, a run with no
// timeline showing its empty state.
import { chromium, expect as baseExpect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Bundles are hash-verified in the browser before any page renders; allow for a loaded machine.
const expect = baseExpect.configure({ timeout: 45_000 });
const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? "screenshots/V3");
await mkdir(out, { recursive: true });
const json = async (path) =>
  JSON.parse(await readFile(new URL(`../public/${path}`, import.meta.url), "utf8"));

const runs = ["demo-run-guarded", "demo-change-api-run-guarded"];
const matrix = [
  [1440, "light"],
  [390, "dark"],
];
const url = (run) => `${base}/app/mission-control?run=${encodeURIComponent(run)}`;
const noOverflow = async (page, width, label) => {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll, `${label} overflows at ${width}`).toBeLessThanOrEqual(width);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const shots = [];
try {
  for (const [width, theme] of matrix) {
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 1000 : 844 },
      reducedMotion: "no-preference",
    });
    await context.addInitScript((t) => localStorage.setItem("notary-theme", t), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Resource 404/503s are expected here (the local-API probe without `notary serve`).
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
    });
    for (const run of runs) {
      const timeline = await json(`bundles/fixture/${run}.timeline.json`);
      const total = timeline.events.length;
      const shot = async (name, full = true) => {
        const file = `${run}-${name}-${theme}-${width}.png`;
        await page.screenshot({ path: resolve(out, file), fullPage: full });
        shots.push(file);
      };
      await page.goto(url(run));
      await expect(page.getByRole("heading", { level: 1, name: "Mission control" })).toBeVisible();
      await expect(page.locator(".fixture-banner").first()).toHaveText(
        "Fixture data — simulated APIs, not a live run",
      );
      await expect(page.getByText("Fixture replay").first()).toBeVisible();
      await expect(page.locator(".stage-node")).toHaveCount(5);
      // Autoplay: events appear over time.
      await page.waitForFunction(
        () => Number(document.querySelector(".replay-scrub input")?.value ?? 0) >= 3,
      );
      await shot("autoplay", false);
      // Mid-replay, paused at half.
      const pause = page.getByRole("button", { name: "Pause replay" });
      if (await pause.isVisible()) await pause.click();
      const half = Math.floor(total / 2);
      await page.locator(".replay-scrub input").fill(String(half));
      await expect(page.locator(".replay-position strong")).toHaveText(String(half));
      await expect(page.locator(".feed-row").first()).toBeVisible();
      await noOverflow(page, width, `${run} mid`);
      await shot("mid");
      // Stage filter from a graph node.
      const enforce = page.locator(".stage-node").nth(4);
      await enforce.click();
      await expect(page.locator(".filter-chip")).toContainText("Enforce");
      await expect(enforce).toHaveAttribute("aria-pressed", "true");
      const stages = await page.locator(".feed-row .stage-tag").allTextContents();
      expect(stages.every((s) => s === "Enforce")).toBe(true);
      await shot("filtered", false);
      await page.locator(".filter-chip").click();
      await expect(page.locator(".filter-chip")).toHaveCount(0);
      // Finished.
      await page.locator(".replay-scrub input").fill(String(total));
      await expect(page.locator(".page-header-actions")).toContainText("Run completed");
      await expect(page.locator(".meters")).toBeVisible();
      await expect(page.getByText("no cap configured").first()).toBeVisible();
      await noOverflow(page, width, `${run} finished`);
      await shot("finished");
      // Record links keep ?run=.
      const href = await page.locator(".feed-record").first().getAttribute("href");
      expect(href).toContain(`run=${run}`);
    }
    expect(errors).toEqual([]);
    await context.close();
  }

  // Reduced motion opens on the finished state, paused.
  const rm = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const rmPage = await rm.newPage();
  await rmPage.goto(url(runs[1]));
  const full = (await json(`bundles/fixture/${runs[1]}.timeline.json`)).events.length;
  await expect(rmPage.locator(".replay-position strong")).toHaveText(String(full));
  await expect(rmPage.getByRole("button", { name: "Replay from the start" })).toBeVisible();
  await expect(rmPage.locator(".stage-node[data-state='failed']")).toHaveCount(1);
  await rmPage.screenshot({ path: resolve(out, "reduced-motion-finished.png"), fullPage: true });
  await rm.close();

  // A timeline that belongs to another bundle hash is withheld.
  const tamper = await browser.newPage();
  await tamper.route("**/bundles/fixture/demo-run-guarded.timeline.json", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.bundleHash = "0".repeat(64);
    await route.fulfill({ response, json: data });
  });
  await tamper.goto(url("demo-run-guarded"));
  await expect(tamper.getByRole("alert")).toContainText("Timeline hash mismatch");
  await expect(tamper.locator(".stage-node")).toHaveCount(0);
  await tamper.screenshot({ path: resolve(out, "timeline-hash-mismatch.png"), fullPage: true });
  await tamper.close();

  // A run with no published timeline names the command that produces one.
  const missing = await browser.newPage();
  await missing.goto(url("sample-42"));
  await expect(missing.getByRole("heading", { name: "No timeline published for sample-42" })).toBeVisible();
  await missing.screenshot({ path: resolve(out, "timeline-missing.png"), fullPage: true });
  await missing.close();

  console.log(`Mission control check passed. ${shots.length + 3} screenshots in ${out}`);
} finally {
  await browser.close();
}
