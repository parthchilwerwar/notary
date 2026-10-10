// Visual + behavior check against a running dev/preview server.
//   NOTARY_PREVIEW_URL  base URL (default http://127.0.0.1:5175)
//   NOTARY_SCREENSHOTS  output dir (default screenshots/V2; gitignored)
//   NOTARY_VISUAL=quick only /app, /app/queue and one record URL at 1440 light + 390 dark
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeContentHash } from "../../core/src/bundle/hash.ts";

const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? "screenshots/V2");
const quick = process.env.NOTARY_VISUAL === "quick";
await mkdir(out, { recursive: true });

const json = async (path) =>
  JSON.parse(await readFile(new URL(`../public/${path}`, import.meta.url), "utf8"));
const guarded = await json("bundles/fixture/demo-run-guarded.json");
const notarize = await json("bundles/fixture/demo-notarize-dodo.json");
const certs = await json("certificates/fixture/default/dodo.json").catch(() => null);
const q = (run) => `?run=${encodeURIComponent(run)}`;
const enc = encodeURIComponent;

// Every route in src/routes.tsx, with record URLs taken from the published fixture data.
const decision = guarded.decisions[0];
const probe = notarize.probes[0];
const belief = notarize.beliefs.after[0];
const allPages = [
  { path: `/app${q(guarded.runId)}`, h1: "Overview", detail: ".funnel-card" },
  { path: `/app/mission-control${q(guarded.runId)}`, h1: "Mission control", detail: ".stage-graph" },
  { path: `/app/runs${q(guarded.runId)}`, h1: "Runs", detail: ".run-tables" },
  { path: `/app/runs/${enc(notarize.runId)}${q(guarded.runId)}`, h1: notarize.runId, detail: ".kpi-grid" },
  { path: `/app/probes${q(notarize.runId)}`, h1: "Probe log", detail: ".probe-timeline .analytics-card" },
  { path: `/app/probes/${enc(probe.id)}${q(notarize.runId)}`, h1: probe.id, detail: ".analytics-card", record: true },
  { path: `/app/certificates${q(notarize.runId)}`, h1: "Certificates", detail: ".certificate-grid" },
  ...(certs?.certificates?.[0]
    ? [{ path: `/app/certificates/${enc(certs.certificates[0].id)}${q(notarize.runId)}`, h1: certs.certificates[0].id, detail: ".certificate-card", record: true }]
    : []),
  { path: `/app/reports${q(notarize.runId)}`, h1: "API reports", detail: ".provider-reports" },
  { path: `/app/reports/dodo${q(notarize.runId)}`, h1: "dodo", detail: ".kpi-grid" },
  { path: `/app/beliefs${q(notarize.runId)}`, h1: "Beliefs", detail: ".belief-card" },
  { path: `/app/beliefs/${enc(belief.id)}${q(notarize.runId)}`, h1: belief.id, detail: ".belief-card", record: true },
  { path: `/app/revocation-demo${q(guarded.runId)}`, h1: "Revocation", detail: ".revocation-sequence" },
  { path: `/app/queue${q(guarded.runId)}`, h1: "Queue", detail: ".request" },
  { path: `/app/queue/${enc(decision.id)}${q(guarded.runId)}`, h1: decision.requestId, detail: ".detail-card", record: true },
  { path: `/app/approvals${q(guarded.runId)}`, h1: "Approval desk", detail: ".table-card, .empty" },
  { path: `/app/ask${q(guarded.runId)}`, h1: "Ask Notary", detail: ".answer-card, .empty" },
  { path: `/app/economics${q(guarded.runId)}`, h1: "Economics", detail: ".economics-grid" },
  { path: `/app/evidence${q(guarded.runId)}`, h1: "Evidence", detail: ".tool-grid" },
];
const pages = quick
  ? allPages.filter((p) => p.h1 === "Overview" || p.h1 === "Queue" || p.h1 === decision.requestId)
  : allPages;
const matrix = quick
  ? [
      [1440, "light"],
      [390, "dark"],
    ]
  : [
      [1440, "light"],
      [1440, "dark"],
      [390, "light"],
      [390, "dark"],
    ];
const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
const slugOf = (p) =>
  p.path.split("?")[0].replace(/^\/app\/?/, "").replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "") || "overview";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = [];
try {
  for (const [width, theme] of matrix) {
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 1000 : 844 },
      reducedMotion: "reduce",
    });
    await context.addInitScript((t) => localStorage.setItem("notary-theme", t), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (!quick) {
      await page.goto(base);
      await expect(page.locator(".results-strip")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await settle(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: resolve(out, `landing-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
      await page.getByRole("link", { name: "Open the dashboard", exact: true }).first().click();
      await expect(page).toHaveURL(/\/app\?run=/);
    }
    for (const p of pages) {
      await page.goto(`${base}${p.path}`);
      await expect(page.getByRole("heading", { level: 1, name: p.h1, exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // Every page here shows a fixture run: the disclosure must be visible.
      await expect(page.locator(".fixture-banner").first()).toHaveText(
        "Fixture data — simulated APIs, not a live run",
      );
      await expect(page.locator(".sidebar-status").first()).toContainText("Fixture");
      await settle(page);
      const metrics = await page.evaluate(() => ({
        viewport: innerWidth,
        scroll: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        theme: document.documentElement.dataset.theme,
        heading: document.querySelector("h1")?.textContent,
      }));
      expect(metrics.scroll, `${p.path} overflows at ${width}`).toBeLessThanOrEqual(width);
      const slug = slugOf(p);
      await page.screenshot({ path: resolve(out, `${slug}-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
      const detail = page.locator(p.detail).first();
      if (await detail.count()) {
        await detail.scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(out, `${slug}-${theme}-${width}-detail.png`), animations: "disabled" });
      }
      report.push({ ...metrics, path: p.path, file: `${slug}-${theme}-${width}.png` });
    }
    // Command palette lists records of the selected run.
    await page.goto(`${base}/app/queue${q(guarded.runId)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.type(decision.requestId);
    await expect(page.locator("[cmdk-item]").first()).toContainText(decision.requestId);
    await page.screenshot({ path: resolve(out, `palette-${theme}-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/app/queue/${enc(decision.id).replace(/[%]/g, "%")}`));
    expect(errors).toEqual([]);
    await context.close();
  }

  // Tampered content is visibly withheld at the rendering boundary.
  const errorPage = await browser.newPage();
  await errorPage.route("**/bundles/sample-42.json", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.metrics.unsafe_actions_total += 1;
    await route.fulfill({ response, json: data });
  });
  await errorPage.goto(`${base}/app/queue`);
  await expect(errorPage.getByRole("alert")).toContainText("hash mismatch");
  await expect(errorPage.locator(".request")).toHaveCount(0);
  await errorPage.screenshot({ path: resolve(out, "integrity-error.png"), fullPage: true });
  await errorPage.close();

  // Deep links survive a reload, and old screen paths redirect with their query.
  const deepPage = await browser.newPage();
  await deepPage.goto(`${base}/app/beliefs/${enc(belief.id)}${q(notarize.runId)}`);
  await expect(deepPage.locator(".belief-card")).toBeVisible();
  await deepPage.reload();
  await expect(deepPage.locator(".belief-card")).toBeVisible();
  await deepPage.goto(`${base}/app/comparison${q(guarded.runId)}`);
  await expect(deepPage).toHaveURL(new RegExp(`/app/runs\\?run=${guarded.runId}`));
  await deepPage.close();

  // Real bundles outrank fixtures by default, are labelled Recorded, and carry no fixture banner.
  const liveRuns = await Promise.all(
    ["naive", "guarded"].map(async (variant) => {
      const data = await json(`bundles/fixture/demo-run-${variant}.json`);
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
        runId: b.runId, kind: b.kind, mode: b.mode, variant: b.variant,
        sample: b.sample, status: b.status, startedAt: b.startedAt, contentHash: b.contentHash,
      })),
    }),
  );
  for (const run of liveRuns)
    await livePage.route(`**/bundles/${run.runId}.json`, (route) => route.fulfill({ json: run }));
  await livePage.goto(`${base}/app`);
  await expect(livePage.getByRole("combobox", { name: "Selected run" })).toHaveValue("visual-live-guarded");
  await expect(livePage.locator(".fixture-banner")).toHaveCount(0);
  await expect(livePage.locator(".sidebar-status").first()).toContainText("Recorded");
  // The picker keeps the two cohorts in separate sections.
  const groups = await livePage.locator(".run-picker optgroup").evaluateAll((els) =>
    els.map((g) => ({ label: g.label, runs: [...g.querySelectorAll("option")].map((o) => o.value) })),
  );
  expect(groups[0].runs.every((r) => r.startsWith("visual-live-"))).toBe(true);
  expect(groups[1].runs.every((r) => !r.startsWith("visual-live-"))).toBe(true);
  await livePage.goto(`${base}/app/runs`);
  await expect(livePage.getByRole("combobox", { name: "Compare with" })).toHaveValue("visual-live-naive");
  await livePage.close();

  await writeFile(resolve(out, "checks.json"), JSON.stringify(report, null, 2));
  console.log(
    `Reviewed ${report.length} route/theme/viewport combinations; no page errors or horizontal overflow. Tamper rejection, deep links, palette and cohort separation passed. Screenshots: ${out}`,
  );
} finally {
  await browser.close();
}
