// Mission control Live mode against a preview/dev server whose /api proxies to `notary serve`.
//   NOTARY_PREVIEW_URL  base URL (default http://127.0.0.1:5175)
//   NOTARY_SCREENSHOTS  output dir (default screenshots/V3)
// 1. Unmocked: the shell opens the SSE stream (GET /api/stream, text/event-stream).
// 2. Mocked local run (a fixture bundle re-labelled real, re-hashed): the timeline comes from
//    /api/bundles/:id/timeline, a `timeline` SSE event is appended live and toasted.
import { chromium, expect as baseExpect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeContentHash } from "../../core/src/bundle/hash.ts";

const expect = baseExpect.configure({ timeout: 45_000 });
const base = process.env.NOTARY_PREVIEW_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.NOTARY_SCREENSHOTS ?? "screenshots/V3");
await mkdir(out, { recursive: true });
const json = async (path) =>
  JSON.parse(await readFile(new URL(`../public/${path}`, import.meta.url), "utf8"));

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  // 1. The SSE connection opens through the proxy.
  const page = await browser.newPage();
  const stream = page.waitForResponse((r) => r.url().includes("/api/stream"));
  await page.goto(`${base}/app`);
  const response = await stream;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/event-stream");
  await expect(page.locator(".sidebar-status").first()).toContainText("API connected");
  await page.close();

  // 2. A local (non-sample) run in Live mode.
  const bundle = await json("bundles/fixture/demo-change-api-run-guarded.json");
  const timeline = await json("bundles/fixture/demo-change-api-run-guarded.timeline.json");
  bundle.sample = false;
  bundle.contentHash = computeContentHash(bundle);
  timeline.sample = false;
  timeline.bundleHash = bundle.contentHash;
  const entry = {
    runId: bundle.runId, kind: bundle.kind, mode: bundle.mode, variant: bundle.variant,
    sample: false, status: bundle.status, startedAt: bundle.startedAt, contentHash: bundle.contentHash,
  };
  const last = timeline.events.at(-1);
  const held = timeline.events.find((e) => e.type === "decision" && e.data?.status === "held");
  const liveEvent = {
    ...held,
    seq: last.seq + 1,
    at: new Date(Date.parse(last.at) + 1000).toISOString(),
    summary: "Live check: request q99 held (stream event).",
    recordIds: [],
    data: { ...held.data, live: true },
  };
  const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await live.route("**/api/bundles", (r) => r.fulfill({ json: [entry] }));
  await live.route(`**/api/bundles/${bundle.runId}`, (r) => r.fulfill({ json: bundle }));
  await live.route(`**/api/bundles/${bundle.runId}/timeline`, (r) => r.fulfill({ json: timeline }));
  let served = false;
  await live.route("**/api/stream**", (r) => {
    // One event, then the stream ends; the client reopens it with ?lastEventId=7.
    const body = served
      ? "retry: 60000\n: connected\n\n"
      : `retry: 500\n: connected\n\nevent: timeline\nid: 7\ndata: ${JSON.stringify({ at: liveEvent.at, payload: liveEvent })}\n\n`;
    served = true;
    return r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  const reconnect = live.waitForRequest((r) => r.url().includes("/api/stream?lastEventId=7"), {
    timeout: 60_000,
  });
  reconnect.catch(() => {}); // awaited below; don't let an earlier failure mask the real error
  await live.goto(`${base}/app/mission-control?run=${bundle.runId}`);
  await expect(live.getByRole("heading", { level: 1, name: "Mission control" })).toBeVisible();
  await expect(live.locator(".fixture-banner")).toHaveCount(0);
  await expect(live.locator(".page-header-actions")).toContainText("Live ·");
  await expect(live.locator(".replay-bar")).toHaveCount(0);
  await expect(live.locator(".feed-summary").first()).toHaveText("Live check: request q99 held (stream event).");
  await expect(live.locator(".feed-live").first()).toHaveText("live");
  await expect(live.getByText("Decision held").first()).toBeVisible();
  await expect(live.locator(".page-header-actions")).toContainText("Run completed");
  await live.screenshot({ path: resolve(out, "live-mode-1440.png"), fullPage: true });
  await reconnect;
  await live.close();
  console.log("Live check passed: SSE opens via the proxy; live events append, toast and reconnect with ?lastEventId=.");
} finally {
  await browser.close();
}
