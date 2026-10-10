import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { computeContentHash } from "../../core/src/bundle/hash.ts";
const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? "screenshots/U5");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = [];
try {
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: width === 1440 ? 1000 : 844 },
        reducedMotion: "reduce",
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base);
      await expect(page.locator(".results-strip")).toBeVisible();
      if (theme === "dark")
        await page
          .getByRole("button", { name: "Switch to dark theme" })
          .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".landing-fixture-label")).toHaveText(
        "Fixture data — simulated APIs with planted quirks",
      );
      await expect(page.locator(".process-steps li")).toHaveCount(5);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
      });
      const landingMetrics = await page.evaluate(() => ({
        viewport: innerWidth,
        scroll: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        theme: document.documentElement.dataset.theme,
        heading: "Landing",
      }));
      expect(landingMetrics.scroll).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: resolve(out, `landing-${theme}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      for (const section of [
        "problem",
        "how-it-works",
        "required-tools",
        "results",
      ]) {
        await page.locator(`#${section}`).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(out, `landing-${section}-${theme}-${width}.png`),
          animations: "disabled",
        });
      }
      report.push({ ...landingMetrics, file: `landing-${theme}-${width}.png` });
      await page
        .getByRole("link", { name: "Open the dashboard", exact: true })
        .first()
        .click();
      await expect(page).toHaveURL(`${base}/app`);
      await expect(page.locator(".verified")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const name of [
        "Overview",
        "Queue",
        "Beliefs",
        "Probe log",
        "Runs comparison",
        "Economics",
        "Evidence",
      ]) {
        await page.getByRole("button", { name, exact: true }).click();
        await expect(
          page.getByRole("heading", { level: 1, name, exact: true }),
        ).toBeVisible();
        await expect(page.locator(".fixture-banner")).toHaveText(
          "Fixture data — simulated APIs, not a live run",
        );
        if (name === "Probe log")
          await page
            .getByRole("combobox", { name: "Filter probes by template" })
            .selectOption("type_edge");
        if (name === "Evidence")
          await expect(
            page.getByRole("heading", { name: "neatlogs", exact: true }),
          ).toBeVisible();
        // Wait for layout/font metrics and two browser paint frames, not a fixed timeout.
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
        });
        const metrics = await page.evaluate(() => ({
          viewport: innerWidth,
          scroll: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
          theme: document.documentElement.dataset.theme,
          heading: document.querySelector("h1")?.textContent,
        }));
        expect(metrics.scroll).toBeLessThanOrEqual(width);
        const slug = name.toLowerCase().replaceAll(" ", "-");
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: resolve(out, `${slug}-${theme}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
        // Preserve the first content card at readable scale for phone review too.
        const detail =
          name === "Overview"
            ? ".funnel-card"
            : name === "Queue"
              ? ".request"
              : name === "Beliefs"
                ? ".belief-card"
                : name === "Probe log"
                  ? ".probe-timeline .analytics-card"
                  : name === "Evidence"
                    ? ".tool-grid"
                    : ".analytics-card";
        await page.locator(detail).first().scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(out, `${slug}-${theme}-${width}-detail.png`),
          animations: "disabled",
        });
        report.push({ ...metrics, file: `${slug}-${theme}-${width}.png` });
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  }
  // Verify tampered content is visibly withheld at the actual rendering boundary.
  const errorPage = await browser.newPage();
  await errorPage.route("**/bundles/sample-42.json", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.metrics.unsafe_actions_total += 1;
    await route.fulfill({ response, json: data });
  });
  await errorPage.goto(base);
  await expect(errorPage.getByRole("alert")).toContainText("hash mismatch");
  await expect(errorPage.locator(".results-strip")).toHaveCount(0);
  await errorPage.goto(`${base}/app`);
  await expect(errorPage.getByRole("alert")).toContainText("hash mismatch");
  await expect(
    errorPage.getByRole("heading", {
      name: "Unsafe money actions",
      exact: true,
    }),
  ).toHaveCount(0);
  await errorPage.screenshot({
    path: resolve(out, "integrity-error.png"),
    fullPage: true,
  });
  await errorPage.close();
  const deepPage = await browser.newPage();
  await deepPage.goto(`${base}/app/beliefs`);
  await expect(
    deepPage.getByRole("heading", { name: "Beliefs", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(deepPage.locator(".verified")).toBeVisible();
  await deepPage.reload();
  await expect(deepPage.locator(".belief-card").first()).toBeVisible();
  await deepPage.close();
  // Rendering check: live bundles outrank fixtures, with independently recomputed hashes.
  const liveRuns = await Promise.all(
    ["naive", "guarded"].map(async (variant) => {
      const data = JSON.parse(
        await readFile(
          new URL(
            `../public/bundles/fixture/demo-run-${variant}.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      data.runId = `visual-live-${variant}`;
      data.sample = false;
      data.contentHash = computeContentHash(data);
      return data;
    }),
  );
  const livePage = await browser.newPage();
  await livePage.route("**/bundles/index.json", (route) =>
    route.fulfill({
      json: liveRuns.map((b) => ({
        runId: b.runId,
        kind: b.kind,
        mode: b.mode,
        variant: b.variant,
        sample: b.sample,
        status: b.status,
        startedAt: b.startedAt,
        contentHash: b.contentHash,
      })),
    }),
  );
  for (const run of liveRuns)
    await livePage.route(`**/bundles/${run.runId}.json`, (route) =>
      route.fulfill({ json: run }),
    );
  await livePage.goto(base);
  await expect(livePage.locator(".cohort-label")).toHaveText(
    "Recorded live runs",
  );
  await expect(livePage.locator(".fixture-banner")).toHaveCount(0);
  await expect(livePage.locator(".result-provenance")).toContainText(
    "visual-live-guarded",
  );
  await expect(livePage.locator(".result-provenance")).not.toContainText(
    "demo-run",
  );
  await livePage
    .getByRole("link", { name: "Inspect the run comparison" })
    .click();
  await expect(
    livePage.getByRole("combobox", { name: "Selected run" }),
  ).toHaveValue("visual-live-guarded");
  await expect(
    livePage.getByRole("combobox", { name: "Compare with" }),
  ).toHaveValue("visual-live-naive");
  await expect(livePage.locator(".fixture-banner")).toHaveCount(0);
  await livePage.close();
  const pendingPage = await browser.newPage();
  await pendingPage.route("**/evidence/evidence.json", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await pendingPage.goto(base);
  await expect(pendingPage.locator(".landing-tool .tool-status")).toHaveText([
    "Pending",
    "Pending",
    "Pending",
  ]);
  await pendingPage.close();
  await writeFile(resolve(out, "checks.json"), JSON.stringify(report, null, 2));
  console.log(
    `Reviewed ${report.length} page/theme/viewport combinations; no page errors or horizontal overflow. Tamper rejection passed. Screenshots: ${out}`,
  );
} finally {
  await browser.close();
}
