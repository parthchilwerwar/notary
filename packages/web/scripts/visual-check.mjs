// Visual + behavior check of the app shell against a running dev/preview server (static data).
//   NOTARY_PREVIEW_URL  base URL (default http://127.0.0.1:5175)
//   NOTARY_SCREENSHOTS  output dir (default screenshots/K3; gitignored)
//   NOTARY_VISUAL=quick only Certificates and one certificate, at 1440 and 390
// Uses the system Chrome (channel "chrome"); no browser download.
//
// Two passes, never mixed: the default view (REAL runs only — no ?run= in the URL; the app picks
// the default run and writes ?run= itself) and the development-only fixture view (?fixtures=1 with
// a fixture run, every run-bound page under the "Fixture data" disclosure). The shell is light only
// (index.html pins data-theme="light"); there is no theme switch to exercise.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? "screenshots/K3");
const quick = process.env.NOTARY_VISUAL === "quick";
await mkdir(out, { recursive: true });

const json = async (path) => JSON.parse(await readFile(new URL(`../public/${path}`, import.meta.url), "utf8"));
const optional = (path, fallback) => json(path).catch(() => fallback);
const enc = encodeURIComponent;
const FIXTURE_BANNER = "Fixture data — simulated APIs, not a live run"; // src/data/types.ts
const REPLAY_CHAT_BANNER = "Replay — answers come from the recorded run, no live lookups"; // src/data/types.ts
// src/routes.tsx navRoutes(), in order; Report is linked from the sidebar footer.
const NAV = ["Run", "Certificates", "Approvals", "Business", "Incidents", "Chat"];

// ---- the published data (record URLs and run ids come from it, nothing is invented) ----
const realRuns = (await optional("bundles/index.json", [])).filter((e) => !e.sample);
const realIds = new Set(realRuns.map((e) => e.runId));
const fixtureRuns = await optional("bundles/fixture/index.json", []);
const fixtureIds = new Set(fixtureRuns.map((e) => e.runId));
if (!realRuns.length) throw new Error("No real runs in public/bundles/index.json: nothing to check in the default view.");

const guarded = await json("bundles/fixture/demo-run-guarded.json");
const notarize = await json("bundles/fixture/demo-notarize-dodo.json");
const changeApi = await optional("bundles/fixture/demo-change-api-run-guarded.json", null);
const fixtureCerts = (await json("certificates/fixture/default/dodo.json")).certificates;
const changeCerts = (await optional("certificates/fixture/change-api/dodo.json", { certificates: [] })).certificates;
const realCerts = [
  ...(await optional("certificates/dodo.json", { certificates: [] })).certificates,
  ...(await optional("certificates/crustdata.json", { certificates: [] })).certificates,
];
const mostEvidence = (list) => [...list].sort((a, b) => (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0))[0];
const realCert = mostEvidence(realCerts);
const fixtureCert = fixtureCerts[0];
const revoked = changeCerts.find((c) => c.status === "revoked");

const fx = (run, extra = "") => `?run=${enc(run)}&fixtures=1${extra}`;

// Every page in src/routes.tsx. `fixtureNote: false`: the page shows real data only, whatever the view.
const realPages = [
  { path: "/app/run?speed=instant", h1: "Run", slug: "run", detail: ".run-transcript-section" },
  { path: "/app/certificates", h1: "Certificates", slug: "certificates", detail: ".certs-list" },
  ...(realCert ? [{ path: `/app/certificates/${enc(realCert.id)}`, h1: realCert.claimId, slug: "certificate", detail: ".cert-pair" }] : []),
  { path: "/app/approvals", h1: "Approvals", slug: "approvals", detail: ".desk-item" },
  { path: "/app/business", h1: "Business", slug: "business", detail: ".biz-figure" },
  { path: "/app/incidents", h1: "Incidents", slug: "incidents" },
  { path: "/app/chat", h1: "Notary Chat", slug: "chat", detail: ".chat-suggestions" },
  { path: "/app/report", h1: "Report", slug: "report", detail: "#connections" },
];
const fixturePages = [
  { path: `/app/run${fx(guarded.runId, "&speed=instant")}`, h1: "Run", slug: "run", detail: ".run-held" },
  { path: `/app/certificates${fx(notarize.runId)}`, h1: "Certificates", slug: "certificates", detail: ".certs-list" },
  { path: `/app/certificates/${enc(fixtureCert.id)}${fx(notarize.runId)}`, h1: fixtureCert.claimId, slug: "certificate", detail: ".cert-pair" },
  ...(revoked && changeApi
    ? [{ path: `/app/certificates/${enc(revoked.id)}${fx(changeApi.runId)}`, h1: revoked.claimId, slug: "certificate-revoked", detail: ".revocation-block" }]
    : []),
  { path: `/app/approvals${fx(guarded.runId)}`, h1: "Approvals", slug: "approvals", detail: ".desk-item" },
  { path: `/app/business${fx(guarded.runId)}`, h1: "Business", slug: "business", fixtureNote: false },
  { path: `/app/incidents${fx(guarded.runId)}`, h1: "Incidents", slug: "incidents" },
  { path: `/app/chat${fx(guarded.runId)}`, h1: "Notary Chat", slug: "chat", detail: ".chat-suggestions" },
  { path: `/app/report${fx(guarded.runId)}`, h1: "Report", slug: "report", detail: "#connections" },
];
const views = [
  { view: "real", pages: realPages, ids: realIds },
  { view: "fixture", pages: fixturePages, ids: fixtureIds },
].map((v) => ({ ...v, pages: quick ? v.pages.filter((p) => p.slug.startsWith("certificate")) : v.pages }));
const widths = quick ? [1440, 390] : [1440, 1024, 390];

const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
const runParam = (page) => new URL(page.url()).searchParams.get("run");
/** The URL has this pathname and (at least) these query params. */
const expectUrl = async (page, pathname, params = {}, label = pathname) => {
  await expect
    .poll(() => {
      const u = new URL(page.url());
      return u.pathname === pathname && Object.entries(params).every(([k, v]) => u.searchParams.get(k) === v);
    }, { message: `${label}: expected ${pathname} with ${JSON.stringify(params)}, got ${page.url()}` })
    .toBe(true);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = [];
try {
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 1000 : 844 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    for (const { view, pages, ids } of views) {
      for (const p of pages) {
        await page.goto(`${base}${p.path}`);
        await expect(page.getByRole("heading", { level: 1, name: p.h1, exact: true })).toBeVisible({ timeout: 30000 });
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
        // The selected run is in the URL and belongs to this view's cohort only.
        await expect.poll(() => runParam(page), { message: `${p.path}: ?run= written` }).not.toBeNull();
        expect(ids.has(runParam(page)), `${p.path}: run ${runParam(page)} is a ${view} run`).toBe(true);
        if (view === "fixture") expect(new URL(page.url()).searchParams.get("fixtures"), `${p.path} keeps ?fixtures=1`).toBe("1");
        // Fixture data always carries the disclosure; real data never does. No app-wide mode banner.
        const banner = page.getByText(FIXTURE_BANNER, { exact: true });
        if (view === "fixture" && p.fixtureNote !== false) await expect(banner.first()).toBeVisible();
        else await expect(banner).toHaveCount(0);
        await expect(page.locator(".replay-banner")).toHaveCount(0);
        if (width >= 768) {
          await expect(page.locator(".side-nav .side-item")).toHaveText(NAV.map((n) => new RegExp(`^${n}`)));
          // No mode item in the navigation (the run picker's run ids may say "replay"; that is data).
          for (const part of [".side-nav", ".side-foot"]) await expect(page.locator(part)).not.toContainText(/Replay|Live/);
          await expect(page.locator(".side-foot").getByRole("link", { name: "Report" })).toBeVisible();
          // The run picker (every page but Run, which has its own) lists this view's cohort only.
          const options = await page.locator(".side .run-picker option").evaluateAll((els) => els.map((o) => o.value).filter(Boolean));
          for (const o of options) expect(ids.has(o), `${p.path}: picker option ${o} is a ${view} run`).toBe(true);
        }
        // Every page opens with the kit's editorial page header (flat, on the page background).
        await expect(page.locator(".ui-header").first()).toBeVisible();
        await settle(page);
        const metrics = await page.evaluate(() => ({
          viewport: innerWidth,
          scroll: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
          heading: document.querySelector("h1")?.textContent,
        }));
        expect(metrics.scroll, `${p.path} overflows at ${width}`).toBeLessThanOrEqual(width);
        const file = `${p.slug}-${view}-${width}.png`;
        await page.screenshot({ path: resolve(out, file), fullPage: true, animations: "disabled" });
        if (p.detail) {
          const detail = page.locator(p.detail).first();
          if (await detail.count()) {
            await detail.scrollIntoViewIfNeeded();
            await page.screenshot({ path: resolve(out, `${p.slug}-${view}-${width}-detail.png`), animations: "disabled" });
          }
        }
        report.push({ ...metrics, view, path: p.path, run: runParam(page), file });
      }
    }

    // Phones: the navigation is a drawer opened by "Menu", closed by Escape (focus returns to Menu).
    if (width < 768) {
      await page.goto(`${base}/app/certificates`);
      await page.getByRole("button", { name: "Menu" }).click();
      await expect(page.locator(".side-drawer")).toHaveAttribute("data-open", "true");
      await expect(page.locator(".side-drawer .side-search")).toBeFocused();
      await expect(page.locator(".side-drawer .side-nav .side-item")).toHaveText(NAV.map((n) => new RegExp(`^${n}`)));
      await settle(page);
      await page.screenshot({ path: resolve(out, `drawer-${width}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(page.locator(".side-drawer")).not.toHaveAttribute("data-open", "true");
      await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
    }

    if (!quick) {
      // Command palette lists records of the selected run (real view: the real certificates).
      if (realCert) {
        await page.goto(`${base}/app/certificates`);
        await expect(page.getByRole("heading", { level: 1, name: "Certificates" })).toBeVisible();
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("dialog", { name: "Search pages and records" })).toBeVisible();
        await page.keyboard.type(realCert.id);
        await expect(page.locator("[cmdk-item]").first()).toContainText(realCert.claimId);
        await page.screenshot({ path: resolve(out, `palette-${width}.png`), animations: "disabled" });
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(`/app/certificates/${realCert.id}`));
        await expect(page.getByRole("heading", { level: 1, name: realCert.claimId, exact: true })).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Search pages and records" })).toHaveCount(0);
      }

      // The palette's Chat action opens Chat with the typed question prefilled (not sent).
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog", { name: "Search pages and records" })).toBeVisible();
      await page.keyboard.type("Why was q02 held?");
      await page.getByRole("option", { name: /Ask Notary Chat: Why was q02 held\?/ }).click();
      await expect(page).toHaveURL(/\/app\/chat\?/);
      await expect(page.getByRole("textbox", { name: "Message Notary" })).toHaveValue("Why was q02 held?");
      await expect(page.locator(".chat-msg")).toHaveCount(0);

      // Chat in replay (fixture world): the banner, a streamed answer with steps that collapse, an
      // unavailable step that names the missing key.
      await page.goto(`${base}/app/chat${fx(guarded.runId)}`);
      await expect(page.locator(".chat-banner")).toContainText(REPLAY_CHAT_BANNER);
      await page.getByRole("textbox", { name: "Message Notary" }).fill("Look up Acme Corp in Crustdata");
      await page.keyboard.press("Enter");
      await expect(page.locator(".chat-footer")).toBeVisible({ timeout: 20000 });
      await expect(page.locator('[data-slot="reasoning-steps-header"]')).toContainText(/Reasoned in \d+ steps?/);
      await page.locator('[data-slot="reasoning-steps-header"]').click();
      await expect(page.locator(".chat-step-fix", { hasText: "CRUSTDATA_API_KEY" }).first()).toBeVisible();
      await settle(page);
      await page.screenshot({ path: resolve(out, `chat-answer-${width}.png`), animations: "disabled" });
    }

    expect(errors).toEqual([]);
    await context.close();
  }

  if (!quick) {
    // Tampered content is visibly withheld at the rendering boundary (a real bundle, hash not updated).
    const tampered = realRuns[0];
    const errorPage = await browser.newPage();
    await errorPage.route(`**/bundles/${tampered.runId}.json`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.metrics.claims = (data.metrics.claims ?? 0) + 1;
      await route.fulfill({ response, json: data });
    });
    await errorPage.goto(`${base}/app/certificates`);
    await expect(errorPage.getByText(/hash mismatch/i).first()).toBeVisible({ timeout: 30000 });
    await errorPage.screenshot({ path: resolve(out, "integrity-error.png"), fullPage: true });
    await errorPage.close();

    // Old URLs redirect to the new pages and keep their query.
    const deepPage = await browser.newPage();
    const decision = guarded.decisions[0];
    const fxq = { run: guarded.runId, fixtures: "1" };
    for (const [from, pathname, params] of [
      [`/app${fx(guarded.runId)}`, "/app/run", fxq],
      ...(decision ? [[`/app/queue/${enc(decision.id)}${fx(guarded.runId)}`, "/app/run", { ...fxq, decision: decision.id }]] : []),
      [`/app/economics${fx(guarded.runId)}`, "/app/business", fxq],
      [`/app/evidence${fx(guarded.runId)}`, "/app/report", fxq],
      [`/app/reports/dodo${fx(notarize.runId)}`, "/app/certificates", { run: notarize.runId, fixtures: "1", tool: "dodo" }],
      ...(fixtureCert.beliefId
        ? [[`/app/beliefs/${enc(fixtureCert.beliefId)}${fx(notarize.runId)}`, `/app/certificates/${fixtureCert.id}`, {}]]
        : []),
    ]) {
      await deepPage.goto(`${base}${from}`);
      await expectUrl(deepPage, pathname, params, from);
    }
    await deepPage.close();

    // Cohorts stay apart in the run picker: the default view lists real runs only, the fixture
    // view fixture runs only (the synthetic sample bundle is in neither). Some loaders read every
    // published bundle (the approvals badge) and filter by cohort before showing anything, so this
    // is checked on screen, not on the network.
    for (const [path, ids, label] of [
      ["/app/report", realIds, /^(Recorded|Live) runs$/],
      [`/app/report${fx(guarded.runId)}`, fixtureIds, /^Fixture runs$/],
    ]) {
      const cohortPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await cohortPage.goto(`${base}${path}`);
      await expect(cohortPage.getByRole("heading", { level: 1, name: "Report" })).toBeVisible({ timeout: 30000 });
      await expect(cohortPage.locator(".side .run-picker option").first()).toBeAttached();
      const groups = await cohortPage.locator(".side .run-picker optgroup").evaluateAll((els) =>
        els.map((g) => ({ label: g.label, runs: [...g.querySelectorAll("option")].map((o) => o.value) })),
      );
      expect(groups.length, `${path}: one cohort in the picker`).toBe(1);
      expect(groups[0].label, path).toMatch(label);
      expect(groups[0].runs.length, `${path}: runs listed`).toBeGreaterThan(0);
      for (const r of groups[0].runs) expect(ids.has(r), `${path}: ${r}`).toBe(true);
      await cohortPage.close();
    }
  }

  await writeFile(resolve(out, "checks.json"), JSON.stringify(report, null, 2));
  console.log(
    `Reviewed ${report.length} route/view/viewport combinations (real runs by default, fixtures under ?fixtures=1); no page errors or horizontal overflow. Light shell, six-item sidebar + Report, drawer${
      quick ? "" : ", palette, Chat prefill and replay answer, tamper rejection, redirects and cohort separation"
    } passed. Screenshots: ${out}`,
  );
} finally {
  await browser.close();
}
