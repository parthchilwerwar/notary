import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? "screenshots/U4");
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
      await expect(page.locator(".verified")).toBeVisible();
      if (theme === "dark")
        await page
          .getByRole("button", { name: "Switch to dark theme" })
          .click();
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
  await writeFile(resolve(out, "checks.json"), JSON.stringify(report, null, 2));
  console.log(
    `Reviewed ${report.length} page/theme/viewport combinations; no page errors or horizontal overflow. Tamper rejection passed. Screenshots: ${out}`,
  );
} finally {
  await browser.close();
}
