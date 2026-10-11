// Visual + behavior check of the app shell against a running dev/preview server (replay mode).
//   NOTARY_PREVIEW_URL  base URL (default http://127.0.0.1:5175)
//   NOTARY_SCREENSHOTS  output dir (default screenshots/K3; gitignored)
//   NOTARY_VISUAL=quick only Certificates and one certificate at 1440 light + 390 dark
// Uses the system Chrome (channel "chrome"); no browser download.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeContentHash } from "../../core/src/bundle/hash.ts";

const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? "screenshots/K3");
const quick = process.env.NOTARY_VISUAL === "quick";
await mkdir(out, { recursive: true });

const json = async (path) => JSON.parse(await readFile(new URL(`../public/${path}`, import.meta.url), "utf8"));
const guarded = await json("bundles/fixture/demo-run-guarded.json");
const notarize = await json("bundles/fixture/demo-notarize-dodo.json");
const changeApi = await json("bundles/fixture/demo-change-api-run-guarded.json");
const certs = await json("certificates/fixture/default/dodo.json");
const changeCerts = await json("certificates/fixture/change-api/dodo.json").catch(() => null);
const q = (run) => `?run=${encodeURIComponent(run)}`;
const enc = encodeURIComponent;

// Every page in src/routes.tsx, with record URLs taken from the published fixture data.
const cert = certs.certificates[0];
const revoked = changeCerts?.certificates.find((c) => c.status === "revoked");
const allPages = [
  { path: `/app/run${q(guarded.runId)}`, h1: "Run", slug: "run", detail: ".run-held" },
  { path: `/app/certificates${q(notarize.runId)}`, h1: "Certificates", slug: "certificates", detail: ".certs-grid" },
  { path: `/app/certificates/${enc(cert.id)}${q(notarize.runId)}`, h1: cert.claimId, slug: "certificate", detail: ".cert-pair" },
  ...(revoked
    ? [{ path: `/app/certificates/${enc(revoked.id)}${q(changeApi.runId)}`, h1: revoked.claimId, slug: "certificate-revoked", detail: ".revocation-block" }]
    : []),
  { path: `/app/approvals${q(guarded.runId)}`, h1: "Approvals", slug: "approvals", detail: ".desk-item" },
  { path: `/app/chat${q(guarded.runId)}`, h1: "Notary Chat", slug: "chat", detail: ".chat-suggestions" },
  { path: `/app/report${q(guarded.runId)}`, h1: "Report", slug: "report", detail: "#connections" },
];
const pages = quick ? allPages.filter((p) => p.slug.startsWith("certificate")) : allPages;
const matrix = quick
  ? [
      [1440, "light"],
      [390, "dark"],
    ]
  : [
      [1440, "light"],
      [1440, "dark"],
      [1024, "light"],
      [1024, "dark"],
      [390, "light"],
      [390, "dark"],
    ];
const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

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
    for (const p of pages) {
      await page.goto(`${base}${p.path}`);
      if (p.h1) await expect(page.getByRole("heading", { level: 1, name: p.h1, exact: true })).toBeVisible({ timeout: 30000 });
      else await page.waitForLoadState("networkidle");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // Every page here shows a fixture run: the disclosure must be visible. The dashboard has no
      // global mode chrome (K3): the replay banner is hidden, the sidebar has no mode item.
      await expect(page.locator(".fixture-banner").first()).toHaveText("Fixture data — simulated APIs, not a live run");
      await expect(page.locator(".replay-banner")).toBeHidden();
      if (width >= 768) {
        await expect(page.locator(".side-nav .side-item")).toHaveText([/^Run/, /^Certificates/, /^Approvals/, /^Chat/]);
        await expect(page.locator(".side")).not.toContainText(/Replay|Live/);
        await expect(page.locator(".side-foot").getByRole("link", { name: "Report" })).toBeVisible();
      }
      // Every page is built on the kit and opens with the sky band.
      await expect(page.locator(".ui-band-sky").first()).toBeVisible();
      await settle(page);
      const metrics = await page.evaluate(() => ({
        viewport: innerWidth,
        scroll: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        theme: document.documentElement.dataset.theme,
        heading: document.querySelector("h1")?.textContent,
      }));
      expect(metrics.scroll, `${p.path} overflows at ${width}`).toBeLessThanOrEqual(width);
      await page.screenshot({ path: resolve(out, `${p.slug}-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
      if (p.detail) {
        const detail = page.locator(p.detail).first();
        if (await detail.count()) {
          await detail.scrollIntoViewIfNeeded();
          await page.screenshot({ path: resolve(out, `${p.slug}-${theme}-${width}-detail.png`), animations: "disabled" });
        }
      }
      report.push({ ...metrics, path: p.path, file: `${p.slug}-${theme}-${width}.png` });
    }

    // Phones: the navigation is a drawer opened by "Menu", closed by Escape (focus returns to Menu).
    if (width < 768) {
      await page.goto(`${base}/app/certificates${q(notarize.runId)}`);
      await page.getByRole("button", { name: "Menu" }).click();
      await expect(page.locator(".side-drawer")).toHaveAttribute("data-open", "true");
      await expect(page.locator(".side-drawer .side-search")).toBeFocused();
      await settle(page);
      await page.screenshot({ path: resolve(out, `drawer-${theme}-${width}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(page.locator(".side-drawer")).not.toHaveAttribute("data-open", "true");
      await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
    }

    // Command palette lists records of the selected run.
    await page.goto(`${base}/app/certificates${q(notarize.runId)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Certificates" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Search pages and records" })).toBeVisible();
    await page.keyboard.type(cert.id);
    await expect(page.locator("[cmdk-item]").first()).toContainText(cert.claimId);
    await page.screenshot({ path: resolve(out, `palette-${theme}-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/app/certificates/${cert.id}`));

    // The palette's Chat action opens Chat with the typed question prefilled (not sent).
    await page.keyboard.press("Control+k");
    await page.keyboard.type("Why was q02 held?");
    await page.getByRole("option", { name: /Ask Notary Chat: Why was q02 held\?/ }).click();
    await expect(page).toHaveURL(/\/app\/chat\?/);
    await expect(page.getByRole("textbox", { name: "Message Notary" })).toHaveValue("Why was q02 held?");
    await expect(page.locator(".chat-msg")).toHaveCount(0);

    // Chat in replay: the banner, a streamed answer with steps that collapse, an unavailable step.
    await page.goto(`${base}/app/chat${q(guarded.runId)}`);
    await expect(page.locator(".chat-banner")).toContainText("Replay — answers come from the recorded run, no live lookups");
    await page.getByRole("textbox", { name: "Message Notary" }).fill("Look up Acme Corp in Crustdata");
    await page.keyboard.press("Enter");
    await expect(page.locator(".chat-footer")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".chat-work-toggle")).toContainText(/Checked \d+ sources?/);
    await page.locator(".chat-work-toggle").click();
    await expect(page.locator(".chat-step-fix", { hasText: "CRUSTDATA_API_KEY" }).first()).toBeVisible();
    await settle(page);
    await page.screenshot({ path: resolve(out, `chat-answer-${theme}-${width}.png`), animations: "disabled" });

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
  await errorPage.goto(`${base}/app/certificates`);
  await expect(errorPage.getByRole("alert")).toContainText("hash mismatch");
  await errorPage.screenshot({ path: resolve(out, "integrity-error.png"), fullPage: true });
  await errorPage.close();

  // Old URLs redirect to the new pages and keep their query.
  const deepPage = await browser.newPage();
  const decision = guarded.decisions[0];
  for (const [from, to] of [
    [`/app${q(guarded.runId)}`, new RegExp(`/app/run\\?run=${guarded.runId}$`)],
    [`/app/queue/${enc(decision.id)}${q(guarded.runId)}`, new RegExp(`/app/run\\?run=${guarded.runId}&decision=${enc(decision.id)}$`)],
    [`/app/economics${q(guarded.runId)}`, new RegExp(`/app/report\\?run=${guarded.runId}$`)],
    [`/app/reports/dodo${q(notarize.runId)}`, new RegExp(`/app/certificates\\?run=${notarize.runId}&tool=dodo$`)],
    [`/app/beliefs/${enc(cert.beliefId)}${q(notarize.runId)}`, new RegExp(`/app/certificates/${cert.id}`)],
  ]) {
    await deepPage.goto(`${base}${from}`);
    await expect(deepPage, from).toHaveURL(to);
  }
  await deepPage.close();

  // Real bundles outrank fixtures by default and carry no fixture banner; cohorts stay apart.
  const liveRuns = await Promise.all(
    ["naive", "guarded"].map(async (variant) => {
      const data = await json(`bundles/fixture/demo-run-${variant}.json`);
      data.runId = `visual-real-${variant}`;
      data.sample = false;
      data.contentHash = computeContentHash(data);
      return data;
    }),
  );
  const realPage = await browser.newPage();
  await realPage.route("**/bundles/index.json", (route) =>
    route.fulfill({
      json: liveRuns.map((b) => ({
        runId: b.runId, kind: b.kind, mode: b.mode, variant: b.variant,
        sample: b.sample, status: b.status, startedAt: b.startedAt, contentHash: b.contentHash,
      })),
    }),
  );
  for (const run of liveRuns) await realPage.route(`**/bundles/${run.runId}.json`, (route) => route.fulfill({ json: run }));
  await realPage.goto(`${base}/app/report`);
  await expect(realPage.getByRole("combobox", { name: "Selected run" })).toHaveValue("visual-real-guarded");
  await expect(realPage.locator(".app-main > .fixture-banner")).toHaveCount(0);
  const groups = await realPage.locator(".run-picker optgroup").evaluateAll((els) =>
    els.map((g) => ({ label: g.label, runs: [...g.querySelectorAll("option")].map((o) => o.value) })),
  );
  expect(groups[0].runs.every((r) => r.startsWith("visual-real-"))).toBe(true);
  expect(groups[1].runs.every((r) => !r.startsWith("visual-real-"))).toBe(true);
  await realPage.close();

  await writeFile(resolve(out, "checks.json"), JSON.stringify(report, null, 2));
  console.log(
    `Reviewed ${report.length} route/theme/viewport combinations; no page errors or horizontal overflow. Sky bands, drawer, palette, Chat prefill and replay answer, tamper rejection, redirects and cohort separation passed. Screenshots: ${out}`,
  );
} finally {
  await browser.close();
}
