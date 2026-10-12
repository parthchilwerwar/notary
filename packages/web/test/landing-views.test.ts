// Landing and replay chat: which runs they show, which files they fetch, per view.
//   - the showcase run is never a replay (the live run that probed the most, without a guarded run)
//   - every landing cache is keyed by (source, ?fixtures=1), re-read per call: /?fixtures=1 → /app →
//     / in one JS module instance never shows fixture data in the real view, nor the reverse
//   - the default view never fetches fixture bundles or the synthetic sample (and the fixture view
//     never fetches real bundles or the synthetic sample)
//   - "Built with" and the chat chips follow evidence/evidence.json (cfo.ai pending → never a chip)
//   - chat: "the last run" is the newest live run, replays are labelled, spend comes from
//     economics.json only (a replay's spend is re-served, never a new cost)
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BundleIndexEntry, ChatEvent, EconomicsFile, RunBundle } from "../../core/src/schema";
import { FIXTURE_BANNER, PublishedFiles, ReplaySource, memoryChatStore, routeQuestion, usd, validateBundle } from "../src/data";
import { REPLAY_SPEND_TEXT, replayBadge } from "../src/app/links";
import { BUILT_WITH, builtWith, cfoPlanImported, clockTime, proofPair, worldNotarizeRuns } from "../src/landing-data";
import { memoByView, mostProbed, previewCandidates, replayFor, replayPair } from "../src/components/landing/replay";
import { loadChatTurn } from "../src/components/landing/chat-turn";
import { FixtureNote } from "../src/ui/Bits";
import { SUITE_HREF, SUITE_LINK_TEXT } from "../src/components/landing/SuiteLink";

const PUBLIC = new URL("../public/", import.meta.url);
const publicJson = (path: string) => JSON.parse(readFileSync(new URL(path, PUBLIC), "utf8"));
const index = () => publicJson("bundles/index.json") as BundleIndexEntry[];
const bundleOf = (e: BundleIndexEntry): RunBundle =>
  validateBundle(publicJson(`bundles/${e.sample ? "fixture/" : ""}${e.runId}.json`), e);

/** PublishedFiles over public/ that records every URL it is asked for. */
function recordingFiles(opts: { missing?: RegExp } = {}) {
  const urls: string[] = [];
  const files = new PublishedFiles({
    base: "/",
    fetchImpl: (async (input: RequestInfo | URL) => {
      const path = decodeURIComponent(String(input).replace(/^\//, ""));
      urls.push(path);
      const file = new URL(path, PUBLIC);
      if ((opts.missing && opts.missing.test(path)) || !existsSync(file))
        return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
      return new Response(readFileSync(file), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  return { files, urls };
}

function setView(fixtures: boolean) {
  vi.stubGlobal("location", { search: fixtures ? "?fixtures=1" : "" });
}

afterEach(() => vi.unstubAllGlobals());

const fixtureBundleFetches = (urls: string[]) => urls.filter((u) => /^bundles\/fixture\/(?!index\.json$)/.test(u) || u.startsWith("certificates/fixture/"));
const syntheticFetches = (urls: string[]) => urls.filter((u) => /sample-42/.test(u));
const realBundleFetches = (urls: string[]) => urls.filter((u) => /^bundles\/[^/]+\.json$/.test(u) && u !== "bundles/index.json");

// --------------------------------------------------------------------------- showcase

describe("landing showcase run", () => {
  it("is never a replay: without a guarded run, the live run that probed the most (newest on a tie)", async () => {
    const real = index().filter((e) => !e.sample);
    expect(real.some((e) => e.mode === "replay")).toBe(true); // the published data has replays to skip
    expect(real.some((e) => e.kind === "run" && e.variant === "guarded")).toBe(false);
    // Expected from the files: the live real runs' probe counts.
    const live = real.filter((e) => e.mode !== "replay").map(bundleOf);
    const most = Math.max(...live.map((b) => b.probes.length));
    const expected = live.filter((b) => b.probes.length === most).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]!;

    setView(false);
    const { files } = recordingFiles();
    const pair = await replayPair(new ReplaySource({ published: files }));
    expect(pair.preview?.runId).toBe(expected.runId);
    expect(pair.preview?.mode).toBe("live");
    expect(pair.sample).toBe(false);
  });

  it("previewCandidates drops replays and the synthetic sample; mostProbed picks the first maximum", () => {
    const e = (runId: string, extra: Partial<BundleIndexEntry>) =>
      ({ runId, kind: "notarize", variant: "notarize", mode: "live", sample: false, startedAt: "2026-10-12T00:00:00.000Z", status: "completed", contentHash: "0".repeat(64), ...extra }) as BundleIndexEntry;
    const list = [
      e("old-live", { startedAt: "2026-10-11T00:00:00.000Z" }),
      e("new-replay", { mode: "replay", startedAt: "2026-10-13T00:00:00.000Z" }),
      e("synthetic", { kind: "sample", variant: "sample", sample: true }),
      e("new-live", {}),
    ];
    expect(previewCandidates(list, false).map((x) => x.runId)).toEqual(["new-live", "old-live"]);
    expect(previewCandidates(list, true)).toEqual([]);
    const b = (runId: string, probes: number) => ({ runId, probes: Array.from({ length: probes }) }) as unknown as RunBundle;
    expect(mostProbed([b("a", 2), b("b", 5), b("c", 5)])?.runId).toBe("b");
    expect(mostProbed([b("a", 0)])).toBeUndefined();
  });

  it("never pairs or sources a replay (Proof pair and How it works records)", () => {
    const guarded = { runId: "g", kind: "run", variant: "guarded", sample: false, startedAt: "2026-10-12T00:00:00.000Z" };
    const replayGuarded = { ...guarded, runId: "g-replay", mode: "replay", startedAt: "2026-10-13T00:00:00.000Z" };
    expect(proofPair([guarded, replayGuarded]).guarded?.runId).toBe("g");
    const notarize = { runId: "n", kind: "notarize", variant: "notarize", sample: false, startedAt: "2026-10-12T00:00:00.000Z" };
    expect(worldNotarizeRuns([notarize, { ...notarize, runId: "n-replay", mode: "replay" }], guarded).map((x) => x.runId)).toEqual(["n"]);
  });
});

// --------------------------------------------------------------------------- views

describe("landing caches are keyed by (source, view)", () => {
  it("/?fixtures=1 → /app → / with the same module and source: each view gets its own data", async () => {
    const { files } = recordingFiles();
    const source = new ReplaySource({ published: files });

    setView(true); // /?fixtures=1
    const fixture = await replayPair(source);
    expect(fixture.sample).toBe(true);
    expect(fixture.preview?.sample).toBe(true);

    setView(false); // → /app → / (client-side; this module stays loaded)
    const real = await replayPair(source);
    expect(real.sample).toBe(false);
    expect(real.preview?.sample).toBe(false);
    expect([real.preview, real.guarded, real.naive].filter(Boolean).every((b) => !b!.sample)).toBe(true);

    setView(true); // and back: the fixture view never shows a real run
    const again = await replayPair(source);
    expect(again).toBe(fixture);
    expect([again.preview, again.guarded, again.naive].filter(Boolean).every((b) => b!.sample)).toBe(true);
  });

  it("memoByView reads the flag per call; replayFor keeps one fallback source per view", async () => {
    const fn = vi.fn(async (_r: ReplaySource, fixtures: boolean) => (fixtures ? "fixture" : "real"));
    const load = memoByView(fn);
    const r = new ReplaySource({ published: recordingFiles().files });
    setView(true);
    expect(await load(r)).toBe("fixture");
    setView(false);
    expect(await load(r)).toBe("real");
    expect(await load(r)).toBe("real");
    expect(fn).toHaveBeenCalledTimes(2);

    const live = { mode: "live" } as unknown as Parameters<typeof replayFor>[0];
    expect(replayFor(live, true)).not.toBe(replayFor(live, false));
    expect(replayFor(live, false)).toBe(replayFor(live, false));
    expect(replayFor(r, true)).toBe(r);
  });

  it("the landing remounts below the nav when the view changes and shows the fixture note under the flag", () => {
    const landing = readFileSync(new URL("../src/Landing.tsx", import.meta.url), "utf8");
    expect(landing).toMatch(/fixturesRequested\(search\)/);
    expect(landing).toMatch(/<main key=\{String\(fixtures\)\}/);
    expect(landing).toMatch(/\{fixtures && \(\s*<Suspense fallback=\{null\}>\s*<FixtureNote /);
    expect(renderToStaticMarkup(createElement(FixtureNote))).toContain(FIXTURE_BANNER);
  });

  it("empty states link the real view to the labelled evaluation suite (the fixture view)", () => {
    expect(SUITE_HREF).toBe("/?fixtures=1");
    expect(SUITE_LINK_TEXT).toBe("See it on the labelled evaluation suite");
    for (const f of ["HowArt.tsx", "FeatureMinis.tsx", "Proof.tsx"])
      expect(readFileSync(new URL(`../src/components/landing/${f}`, import.meta.url), "utf8")).toMatch(/<SuiteLink \/>/);
  });
});

// --------------------------------------------------------------------------- fetches

describe("what the landing and the replay chat fetch, per view", () => {
  it("default view: the showcase and the chat turn fetch no fixture bundle and no synthetic sample", async () => {
    setView(false);
    const { files, urls } = recordingFiles();
    const source = new ReplaySource({ published: files });
    await replayPair(source);
    await loadChatTurn(source);
    expect(fixtureBundleFetches(urls)).toEqual([]);
    expect(syntheticFetches(urls)).toEqual([]);
  }, 30000);

  it("fixture view: fixture scenario runs only (no real bundle, no synthetic sample)", async () => {
    setView(true);
    const { files, urls } = recordingFiles();
    const source = new ReplaySource({ published: files });
    const pair = await replayPair(source);
    expect(pair.sample).toBe(true);
    await loadChatTurn(source);
    expect(realBundleFetches(urls).filter((u) => !u.startsWith("bundles/fixture/"))).toEqual([]);
    expect(syntheticFetches(urls)).toEqual([]);
  }, 30000);

  it("an unpinned replay chat fetches only the view's cohort", async () => {
    for (const fixtures of [false, true]) {
      const { files, urls } = recordingFiles();
      const source = new ReplaySource({ published: files, chat: { store: memoryChatStore(), pace: "instant", fixtures: () => fixtures } });
      const c = await source.chat.createConversation();
      const events: ChatEvent[] = [];
      await source.chat.sendMessage(c.id, "What happened in the runs?", (e) => events.push(e));
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(syntheticFetches(urls)).toEqual([]);
      if (fixtures) expect(realBundleFetches(urls).filter((u) => !u.startsWith("bundles/fixture/"))).toEqual([]);
      else expect(fixtureBundleFetches(urls)).toEqual([]);
    }
  }, 30000);
});

// --------------------------------------------------------------------------- built with

describe("Built with and the chat chips follow evidence.json", () => {
  const evidence = (status: "live" | "pending") => [
    { name: "neatlogs", status: "live" as const },
    { name: "cfo.ai", status },
  ];
  it("a pending integration is a labelled credit, never a chip", () => {
    const { credits, chips } = builtWith(evidence("pending"), { cfoPlan: false });
    expect(credits.find((c) => c.name === "cfo.ai")).toEqual({ name: "cfo.ai", pending: "pending plan import" });
    expect(chips).not.toContain("cfo.ai");
    expect(chips).toEqual(BUILT_WITH.filter((n) => n !== "cfo.ai"));
  });
  it("cfo.ai is active only when evidence says live and economics.json has an imported plan", () => {
    expect(builtWith(evidence("live"), { cfoPlan: true }).chips).toContain("cfo.ai");
    expect(builtWith(evidence("live"), { cfoPlan: false }).chips).not.toContain("cfo.ai");
    expect(builtWith(null)).toEqual({ credits: [], chips: [] });
  });
  it("matches the published evidence.json and economics.json", () => {
    const published = publicJson("evidence/evidence.json") as { name: string; status: "live" | "pending" }[];
    const plan = cfoPlanImported(publicJson("economics.json"));
    const cfo = published.find((e) => e.name === "cfo.ai");
    const { chips, credits } = builtWith(published, { cfoPlan: plan });
    expect(chips.includes("cfo.ai")).toBe(cfo?.status === "live" && plan);
    if (cfo?.status === "pending") expect(credits.find((c) => c.name === "cfo.ai")?.pending).toBe("pending plan import");
  });
  it("the chips and credits are rendered from builtWith, not from the raw list", () => {
    const below = readFileSync(new URL("../src/components/landing/Below.tsx", import.meta.url), "utf8");
    const section = readFileSync(new URL("../src/components/landing/ChatSection.tsx", import.meta.url), "utf8");
    expect(below).toMatch(/builtWith\(evidence, \{ cfoPlan \}\)/);
    expect(section).not.toMatch(/BUILT_WITH/);
  });
});

// --------------------------------------------------------------------------- chat

let ids = 0;
function chatSource(opts: { missing?: RegExp } = {}) {
  const { files, urls } = recordingFiles(opts);
  const source = new ReplaySource({
    published: files,
    chat: { store: memoryChatStore(), pace: "instant", now: () => 0, clock: () => new Date("2026-10-12T00:00:00.000Z"), newId: () => `v${++ids}`, fixtures: () => false },
  });
  return { source, urls };
}
async function ask(source: ReplaySource, question: string, runId?: string) {
  source.chat.setContext({ runId });
  const c = await source.chat.createConversation();
  const events: ChatEvent[] = [];
  await source.chat.sendMessage(c.id, question, (e) => events.push(e));
  return events;
}
const text = (events: ChatEvent[]) => events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
const citations = (events: ChatEvent[]) => events.flatMap((e) => (e.type === "citations" ? e.items : []));

describe("replay chat: the last run, replays and spend", () => {
  const real = () => index().filter((e) => !e.sample);
  const newestLive = () => real().filter((e) => e.mode !== "replay").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]!;
  const aReplay = () => real().find((e) => e.mode === "replay")!;

  it("routes last-run and spend questions", () => {
    expect(routeQuestion("What happened in the last run?", { runIds: [], claimIds: [] }).intents).toEqual([{ kind: "runs", latest: true }]);
    expect(routeQuestion("How much did the runs cost?", { runIds: [], claimIds: [] }).intents[0]).toEqual({ kind: "cost" });
    expect(routeQuestion("What did the last run spend?", { runIds: [], claimIds: [] }).intents[0]).toEqual({ kind: "cost", latest: true });
    expect(routeQuestion("cost of r-1", { runIds: ["r-1"], claimIds: [] }).intents).toEqual([{ kind: "cost", runId: "r-1" }]);
    expect(routeQuestion("Why was q02 held, how much was it?", { runIds: [], claimIds: [] }).intents.some((i) => i.kind === "cost")).toBe(false);
  });

  it("the last run is the newest LIVE run, even when a replay is newer; replays are listed after it, labelled", async () => {
    const replay = aReplay();
    expect(replay.startedAt > newestLive().startedAt).toBe(true); // a newer replay exists to skip
    const { source } = chatSource();
    const events = await ask(source, "What happened in the last run?");
    const answer = text(events);
    expect(answer).toContain(`The last live run is \`${newestLive().runId}\``);
    const replayBundle = bundleOf(replay);
    expect(answer).toContain(replayBadge(replayBundle)!);
    // Live runs before replays in the listing.
    const firstReplay = answer.indexOf("-replay`");
    expect(answer.indexOf(`\`${newestLive().runId}\``)).toBeLessThan(firstReplay);
    const runsStep = events.find((e): e is Extract<ChatEvent, { type: "step_finished" }> => e.type === "step_finished" && (e.data as { kind?: string })?.kind === "runs");
    const listed = (runsStep!.data as { runs: { mode: string; label?: string }[] }).runs;
    const modes = listed.map((r) => r.mode);
    expect(modes.indexOf("replay")).toBeGreaterThan(modes.lastIndexOf("live"));
    expect(listed.filter((r) => r.mode === "replay").every((r) => r.label?.startsWith("Replay of "))).toBe(true);
    expect(citations(events).find((c) => c.id === replay.runId)?.label).toContain("Replay of ");
  }, 30000);

  it("answers spend from economics.json with citations; replays are re-served, never a new cost", async () => {
    const econ = publicJson("economics.json") as EconomicsFile;
    const { source } = chatSource();
    const events = await ask(source, "How much did the runs cost?");
    const answer = text(events);
    expect(answer).toContain(usd(econ.computed!.totals.modelUsd));
    expect(answer).toContain(`${econ.computed!.totals.credits} credits`);
    expect(answer).toContain(REPLAY_SPEND_TEXT);
    expect(answer).toContain("/app/business");
    expect(citations(events).some((c) => c.type === "api_response" && c.label.includes("economics.json"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });

    const replay = bundleOf(aReplay());
    const own = econ.computed!.runs.find((r) => r.runId === replay.runId);
    const forReplay = text(await ask(source, `What did ${replay.runId} cost?`));
    expect(forReplay).toContain(`${replayBadge(replay)}): ${REPLAY_SPEND_TEXT}`);
    // The replay's own row is never presented as its spend; only the original's, named as such.
    if (own && replay.replayOf) expect(forReplay).toContain(`The original run \`${replay.replayOf}\``);
  }, 30000);

  it("without economics.json it says where to look, and invents no number", async () => {
    const { source } = chatSource({ missing: /^economics\.json$/ });
    const answer = text(await ask(source, "What is the cost per run?"));
    expect(answer).toContain("public/economics.json");
    expect(answer).toContain("/app/business");
    expect(answer).not.toMatch(/\$\d/);
  }, 30000);

  it("a fixture world has no spend: no number, a pointer to the real figures", async () => {
    const { source } = chatSource();
    const answer = text(await ask(source, "How much did this cost?", "demo-run-guarded"));
    expect(answer).toContain("real runs only");
    expect(answer).not.toMatch(/\$\d/);
  }, 30000);
});

describe("landing clock times", () => {
  it("are UTC and labelled", () => {
    expect(clockTime("2026-10-12T01:14:04.667Z")).toBe("01:14:04 UTC");
  });
});

describe("landing nav on phones", () => {
  it("has a Menu disclosure (aria-expanded, aria-controls) holding the section links, closed by default", async () => {
    const { MemoryRouter } = await import("react-router");
    const { Nav } = await import("../src/components/landing/Nav");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Nav, { showPricing: false })));
    expect(html).toMatch(/<button[^>]*class="l-nav-menu-btn"[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"/);
    const id = /aria-controls="([^"]+)"/.exec(html)![1]!;
    expect(html).toMatch(new RegExp(`<nav id="${id.replace(/[:]/g, "\:")}" class="l-nav-menu"[^>]*hidden=""`));
    expect(html).toContain(">Menu<");
    const src = readFileSync(new URL("../src/components/landing/Nav.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/e\.key !== "Escape"/);
    expect(src).toMatch(/onClick=\{\(\) => setOpen\(false\)\}/);
  });
});

describe("small UI guards", () => {
  it("the chat composer shows a solid focus ring (existing --focus-ring token)", () => {
    const css = readFileSync(new URL("../src/pages/chat/chat.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.chat-composer:has\(textarea:focus-visible\)\s*\{\s*outline: var\(--focus-ring\);/);
  });
  it("landing tweens never target elements that may be absent (no GSAP 'target not found')", () => {
    const how = readFileSync(new URL("../src/components/landing/HowArt.tsx", import.meta.url), "utf8");
    const preview = readFileSync(new URL("../src/components/landing/RunPreview.tsx", import.meta.url), "utf8");
    expect(how).toMatch(/if \(view\.rows\.length\) tl\.from\("\.h-guard"/);
    expect(preview).toMatch(/if \(!rows\.length\) return;[^\n]*\n\s*gsap\.from\("\.l-preview-row"/);
  });
});
