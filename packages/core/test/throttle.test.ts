/**
 * Crustdata throttle (15 requests per rolling minute, process-wide) and 429 handling. All traffic is
 * hand-built TEST DATA from a stubbed transport; time is virtual or manually advanced, so nothing
 * here sleeps for real and nothing touches the network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRecon } from "../src/checker/recon.js";
import { contractFor } from "../src/contracts/index.js";
import {
  CRUSTDATA_MAX_REQUESTS_PER_WINDOW,
  CRUSTDATA_RATE_WINDOW_MS,
  CreditLedger,
  DODO_TEST_BASE_URL,
  RateLimitScope,
  RateLimitedError,
  SlidingWindowLimiter,
  VirtualClock,
  backOffFromHeaders,
  createTools,
  crustdataRpmFromEnv,
  identityWrap,
  rateLimitScope,
  setRateLimitScope,
  setRecorderTransport,
} from "../src/tools/index.js";
import type { Clock, FetchLike } from "../src/tools/index.js";

const FAKE_DODO_KEY = ["test", "dodo", "key", "x".repeat(16)].join("_");
const FAKE_CRUST_KEY = ["fake", "crust", "y".repeat(20)].join("-");
const liveEnv = (): NodeJS.ProcessEnv => ({
  NOTARY_MODE: "test",
  DODO_BASE_URL: DODO_TEST_BASE_URL,
  DODO_PAYMENTS_API_KEY: FAKE_DODO_KEY,
  CRUSTDATA_API_KEY: FAKE_CRUST_KEY,
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const ENRICH_HIT = [{ matched_on: "acme.example", match_type: "domain", matches: [] }];

/** A stub API: Crustdata answers per path, Dodo answers an empty list. Counts requests per host. */
function stubApi(crust?: (url: string, n: number) => Response) {
  const counts = { crustdata: 0, dodo: 0 };
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("crustdata")) {
      counts.crustdata += 1;
      if (crust) return crust(url, counts.crustdata);
      if (url.endsWith("/account/credits")) return json({ account: { credits: 100 } }, 200, { "x-credits-used": "0" });
      return json(ENRICH_HIT, 200, { "x-credits-used": "2" });
    }
    counts.dodo += 1;
    return json({ items: [] });
  };
  return { fetch, counts };
}

/** A clock whose sleeps resolve only when the test advances time past them. */
class ManualClock implements Clock {
  t = 0;
  private sleepers: Array<{ at: number; resolve: () => void }> = [];
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.sleepers.push({ at: this.t + ms, resolve }));
  }
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.sleepers.filter((s) => s.at <= this.t);
    this.sleepers = this.sleepers.filter((s) => s.at > this.t);
    for (const s of due) s.resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

/** A clock that fails the test if anything waits on it. */
const noSleepClock: Clock = {
  now: () => 0,
  sleep: async (ms) => {
    throw new Error(`unexpected throttle wait of ${ms} ms`);
  },
};

let dir: string;
const restores: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notary-throttle-"));
  // Refuse the real network outright: every live request below goes through an installed transport.
  vi.stubGlobal("fetch", async () => {
    throw new Error("network disabled in throttle tests");
  });
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function install(fetch: FetchLike, rateLimits?: RateLimitScope, fixture = false): void {
  restores.push(setRecorderTransport({ fetch, fixture, ...(rateLimits ? { rateLimits } : {}) }));
}

describe("sliding window limiter", () => {
  it("lets 15 requests through and holds the 16th until the oldest leaves the 60 s window", async () => {
    const clock = new ManualClock();
    const limiter = new SlidingWindowLimiter("crustdata", CRUSTDATA_MAX_REQUESTS_PER_WINDOW, CRUSTDATA_RATE_WINDOW_MS, clock, true);
    for (let i = 0; i < 15; i++) {
      expect(await limiter.acquire()).toBe(0);
      await clock.advance(1000); // 15 requests over 15 s
    }
    let waited: number | null = null;
    void limiter.acquire().then((w) => {
      waited = w;
    });
    await clock.advance(0);
    expect(waited).toBeNull();
    // The first start was at t=0, so its slot frees at t=60 000; now is t=15 000.
    await clock.advance(44_999);
    expect(waited).toBeNull();
    await clock.advance(1);
    expect(waited).toBe(45_000);
    expect(clock.now()).toBe(60_000);
    expect(limiter.stats()).toMatchObject({ requests: 16, waits: 1, totalWaitMs: 45_000, maxWaitMs: 45_000, limit: 15, windowMs: 60_000 });
  });

  it("serializes concurrent callers so a burst never overshoots the window", async () => {
    const clock = new VirtualClock();
    const limiter = new SlidingWindowLimiter("crustdata", 15, 60_000, clock, true);
    const waits = await Promise.all(Array.from({ length: 31 }, () => limiter.acquire()));
    // All 31 land at t=0: 15 go, the 16th opens the next window at t=60 s (and with it 14 more
    // slots), the 31st waits for the window after that.
    expect(waits.filter((w) => w > 0)).toEqual([60_000, 60_000]);
    expect(waits[15]).toBe(60_000);
    expect(waits[30]).toBe(60_000);
    expect(clock.now()).toBe(120_000);
    expect(limiter.stats()).toMatchObject({ requests: 31, waits: 2, totalWaitMs: 120_000 });
  });

  it("Dodo is not throttled", () => {
    expect(new RateLimitScope({ clock: new VirtualClock() }).limiter("dodo")).toBeNull();
  });
});

describe("one limiter per process, shared by recon, probes and the queue", () => {
  it("recon + probe tools + queue tools (three Recorders) draw from the same window", async () => {
    const scope = new RateLimitScope({ clock: new VirtualClock() });
    const api = stubApi();
    install(api.fetch, scope);
    const env = liveEnv();

    // 1. Recon, exactly as `notarize` runs it (its own createTools/Recorder inside runRecon).
    const entries = contractFor("crustdata").slice(0, 1);
    await runRecon({ tool: "crustdata", mode: "live", cassetteDir: dir, env, entries, sleep: async () => {} });
    const reconRequests = api.counts.crustdata;
    expect(reconRequests).toBeGreaterThan(0);
    expect(reconRequests).toBeLessThan(15);
    expect(scope.stats("crustdata")).toMatchObject({ requests: reconRequests, waits: 0 });

    // 2. Probes: a second Recorder (reflect/notarize.ts builds one for the probe cassette).
    const probes = createTools({ mode: "live", cassette: "probes", cassetteDir: dir, ledger: new CreditLedger({ budget: 1000 }), env });
    while (api.counts.crustdata < 15) await probes.crustdata.getCreditBalance();
    expect(scope.stats("crustdata")).toMatchObject({ requests: 15, waits: 0 });

    // 3. Queue enrichment: a third Recorder (queue/run.ts). Its first call is the 16th in the window.
    const queue = createTools({ mode: "live", cassette: "queue", cassetteDir: dir, ledger: new CreditLedger({ budget: 1000 }), env, wrap: identityWrap });
    await queue.crustdata.enrichCompany({ domains: ["acme.example"], fields: ["headcount"] });
    const stats = scope.stats("crustdata")!;
    expect(stats.requests).toBe(16);
    expect(stats.waits).toBe(1);
    expect(stats.totalWaitMs).toBeGreaterThan(0);
    expect(stats.totalWaitMs).toBeLessThanOrEqual(CRUSTDATA_RATE_WINDOW_MS);
    expect(scope.clock.now()).toBeGreaterThanOrEqual(CRUSTDATA_RATE_WINDOW_MS);

    // Dodo traffic through the same Recorders never touches the limiter.
    for (let i = 0; i < 20; i++) await queue.dodo.listRefunds({ customer_id: "cus_1" });
    expect(scope.stats("crustdata")!.requests).toBe(16);
    expect(scope.stats().map((s) => s.tool)).toEqual(["crustdata"]);
  });

  it("without an override every Recorder resolves the same process scope and limiter, on real time", () => {
    restores.push(setRateLimitScope(null)); // lift the virtual-time scope test/setup-virtual-time.ts installs
    expect(rateLimitScope()).toBe(rateLimitScope());
    expect(rateLimitScope().limiter("crustdata")).toBe(rateLimitScope().limiter("crustdata"));
    expect(rateLimitScope().virtual).toBe(false);
    expect(rateLimitScope().limiter("crustdata")!.limit).toBe(crustdataRpmFromEnv(process.env));
  });
});

describe("replay and fixture transports", () => {
  it("replay never waits, however many Crustdata exchanges it serves", async () => {
    const recordScope = new RateLimitScope({ clock: new VirtualClock() });
    const api = stubApi();
    install(api.fetch, recordScope);
    const live = createTools({ mode: "live", cassette: "burst", cassetteDir: dir, env: liveEnv(), ledger: new CreditLedger({ budget: 1000 }) });
    for (let i = 0; i < 20; i++) await live.crustdata.getCreditBalance();
    expect(recordScope.stats("crustdata")!.waits).toBe(1); // the recording itself was throttled
    restores.pop()!();

    const replayScope = new RateLimitScope({ clock: noSleepClock });
    restores.push(setRateLimitScope(replayScope));
    const replay = createTools({ mode: "replay", cassette: "burst", cassetteDir: dir });
    for (let i = 0; i < 20; i++) await replay.crustdata.getCreditBalance();
    expect(replay.recorder.exchanges()).toHaveLength(20);
    expect(replayScope.stats()).toEqual([]); // the limiter was never even consulted
  });

  it("a fixture transport runs on virtual time but still counts and reports the would-be waits", async () => {
    const api = stubApi();
    restores.push(setRecorderTransport({ fetch: api.fetch, fixture: true }));
    const scope = rateLimitScope();
    expect(scope.virtual).toBe(true);
    const tools = createTools({ mode: "live", cassette: "demo-fixture", cassetteDir: dir, env: liveEnv(), ledger: new CreditLedger({ budget: 1000 }) });
    const started = Date.now();
    for (let i = 0; i < 31; i++) await tools.crustdata.getCreditBalance();
    expect(Date.now() - started).toBeLessThan(5000); // two full windows of waiting, zero wall time
    expect(scope.stats("crustdata")).toMatchObject({ virtual: true, requests: 31, waits: 2, totalWaitMs: 120_000 });
    restores.pop()!();
    expect(rateLimitScope()).not.toBe(scope); // restoring the transport restores the scope
  });
});

describe("Crustdata 429", () => {
  const limited = (headers: Record<string, string> = {}) =>
    json({ error: "rate_limited", description: "Too many requests" }, 429, headers);

  it("waits out Retry-After once (pausing the shared limiter), retries, and charges nothing for the 429", async () => {
    const scope = new RateLimitScope({ clock: new VirtualClock() });
    const api = stubApi((_url, n) => (n === 1 ? limited({ "retry-after": "7" }) : json(ENRICH_HIT, 200, { "x-credits-used": "2" })));
    install(api.fetch, scope);
    const ledger = new CreditLedger({ budget: 100 });
    const tools = createTools({ mode: "live", cassette: "r429", cassetteDir: dir, env: liveEnv(), ledger });

    const res = await tools.crustdata.enrichCompany({ domains: ["acme.example"], fields: ["headcount"] });
    expect(res.status).toBe(200);
    expect(api.counts.crustdata).toBe(2);
    const [first, second] = tools.recorder.exchanges();
    expect(first!.status).toBe(429);
    expect(first!.responseHeaders["retry-after"]).toBe("7"); // the back-off is in the recorded exchange
    expect(first!.credits).toBe(0);
    expect(second!.status).toBe(200);
    expect(scope.stats("crustdata")).toMatchObject({ requests: 2, backOffs: 1, waits: 1, totalWaitMs: 7000 });
    expect(ledger.snapshot()).toMatchObject({ total: 2, reserved: 0, calls: { "crustdata.enrichCompany": 2 } });

    // Replay of the same cassette makes the same decision (retry, succeed) and never waits.
    restores.push(setRateLimitScope(new RateLimitScope({ clock: noSleepClock })));
    const replayLedger = new CreditLedger({ budget: 100 });
    const replay = createTools({ mode: "replay", cassette: "r429", cassetteDir: dir, ledger: replayLedger });
    expect((await replay.crustdata.enrichCompany({ domains: ["acme.example"], fields: ["headcount"] })).status).toBe(200);
    expect(replayLedger.snapshot().total).toBe(2);
  });

  it("a second 429 fails cleanly with RateLimitedError after exactly one retry", async () => {
    const scope = new RateLimitScope({ clock: new VirtualClock() });
    const api = stubApi(() => limited({ "x-ratelimit-reset": "30", "x-ratelimit-remaining": "0" }));
    install(api.fetch, scope);
    const ledger = new CreditLedger({ budget: 100 });
    const tools = createTools({ mode: "live", cassetteDir: dir, env: liveEnv(), ledger });

    const err = await tools.crustdata.enrichCompany({ domains: ["acme.example"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toMatchObject({ status: 429, attempts: 2, retryAfterMs: 30_000, op: "crustdata.enrichCompany" });
    expect((err as Error).message).toMatch(/HTTP 429 rate limited after 2 requests/);
    expect(api.counts.crustdata).toBe(2);
    expect(scope.stats("crustdata")).toMatchObject({ requests: 2, backOffs: 1, totalWaitMs: 30_000 });
    expect(ledger.snapshot()).toMatchObject({ total: 0, reserved: 0 });
  });

  it("a back-off longer than Notary will wait fails at once, without a retry", async () => {
    const api = stubApi(() => limited({ "retry-after": "3600" }));
    install(api.fetch, new RateLimitScope({ clock: new VirtualClock() }));
    const tools = createTools({ mode: "live", cassetteDir: dir, env: liveEnv() });
    const err = await tools.crustdata.getCreditBalance().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toMatchObject({ attempts: 1, retryAfterMs: 3_600_000 });
    expect(api.counts.crustdata).toBe(1);
  });

  it("a 429 that reports X-Credits-Used is charged what the API says", async () => {
    const api = stubApi((_url, n) => (n === 1 ? limited({ "x-credits-used": "0.5" }) : json(ENRICH_HIT, 200, { "x-credits-used": "2" })));
    install(api.fetch, new RateLimitScope({ clock: new VirtualClock() }));
    const ledger = new CreditLedger({ budget: 100 });
    const tools = createTools({ mode: "live", cassetteDir: dir, env: liveEnv(), ledger });
    await tools.crustdata.enrichCompany({ domains: ["acme.example"] });
    expect(ledger.snapshot().total).toBe(2.5);
  });

  it("reads Retry-After and x-ratelimit-reset in their documented and common forms", () => {
    const at = Date.parse("2026-10-10T12:00:00.000Z");
    expect(backOffFromHeaders({ "retry-after": "12" }, at)).toBe(12_000);
    expect(backOffFromHeaders({ "retry-after": "Sat, 10 Oct 2026 12:00:05 GMT" }, at)).toBe(5000);
    expect(backOffFromHeaders({ "x-ratelimit-reset": "20" }, at)).toBe(20_000);
    expect(backOffFromHeaders({ "x-ratelimit-reset": String(at / 1000 + 9) }, at)).toBe(9000);
    expect(backOffFromHeaders({ "x-ratelimit-reset": String(at + 4000) }, at)).toBe(4000);
    expect(backOffFromHeaders({}, at)).toBeNull();
  });
});

describe("NOTARY_CRUSTDATA_RPM", () => {
  it("can lower the limit but never raise it above the documented 15", () => {
    expect(crustdataRpmFromEnv({})).toBe(15);
    expect(crustdataRpmFromEnv({ NOTARY_CRUSTDATA_RPM: "5" })).toBe(5);
    expect(crustdataRpmFromEnv({ NOTARY_CRUSTDATA_RPM: "15" })).toBe(15);
    expect(crustdataRpmFromEnv({ NOTARY_CRUSTDATA_RPM: "100" })).toBe(15);
    expect(crustdataRpmFromEnv({ NOTARY_CRUSTDATA_RPM: "0" })).toBe(15);
    expect(crustdataRpmFromEnv({ NOTARY_CRUSTDATA_RPM: "-3" })).toBe(15);
    expect(crustdataRpmFromEnv({ NOTARY_CRUSTDATA_RPM: "fast" })).toBe(15);
    expect(crustdataRpmFromEnv({ NOTARY_CRUSTDATA_RPM: "7.9" })).toBe(7);
  });

  it("the scope applies the clamped override to live requests", async () => {
    const lowered = new RateLimitScope({ clock: new VirtualClock(), env: { NOTARY_CRUSTDATA_RPM: "5" } });
    expect(lowered.limiter("crustdata")!.limit).toBe(5);
    expect(new RateLimitScope({ clock: new VirtualClock(), env: { NOTARY_CRUSTDATA_RPM: "60" } }).limiter("crustdata")!.limit).toBe(15);

    const api = stubApi();
    install(api.fetch, lowered);
    const tools = createTools({ mode: "live", cassetteDir: dir, env: liveEnv() });
    for (let i = 0; i < 6; i++) await tools.crustdata.getCreditBalance();
    expect(lowered.stats("crustdata")).toMatchObject({ limit: 5, requests: 6, waits: 1, totalWaitMs: 60_000 });
  });
});
