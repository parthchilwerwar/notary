import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/api/bus.js";
import { createApp, HASH_MISMATCH_HEADER } from "../src/api/server.js";
import { buildSampleBundle, verifyBundle, writeBundle } from "../src/bundle/index.js";
import { BundleIndexSchema } from "../src/schema/bundle.js";

let root: string;
let webDir: string;
let runsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "notary-api-"));
  webDir = join(root, "web");
  runsDir = join(root, "runs");
  // sample-42 lives in both the web dir and runs/ (dedupe); sample-7 only in runs/.
  await writeBundle(buildSampleBundle(42), webDir);
  await writeBundle(buildSampleBundle(42), join(runsDir, "sample-42"));
  await writeBundle(buildSampleBundle(7), join(runsDir, "sample-7"));
  // sample-9 is tampered after writing: schema-valid, hash no longer matches.
  const tamperedDir = join(runsDir, "sample-9");
  await writeBundle(buildSampleBundle(9), tamperedDir);
  const file = join(tamperedDir, "sample-9.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as { disclosure: string[] };
  raw.disclosure.push("edited by hand");
  await writeFile(file, JSON.stringify(raw), "utf8");
  // A file outside any bundle dir that a traversal would try to reach.
  await writeFile(join(root, "secret.json"), JSON.stringify({ secret: "do-not-serve" }), "utf8");
  // Junk in runs/: a non-directory and a directory with an invalid index are ignored.
  await writeFile(join(runsDir, "stray.txt"), "x", "utf8");
  await mkdir(join(runsDir, "broken"), { recursive: true });
  await writeFile(join(runsDir, "broken", "index.json"), "{not json", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function app(bus = new EventBus(), keepAliveMs = 60_000) {
  return createApp({ bundleDirs: [webDir], runsDir, bus, keepAliveMs });
}

/** Read an SSE response body until `until` matches the accumulated text (or time out). */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until: (text: string) => boolean, timeoutMs = 2000): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for SSE text; got:\n${text}`);
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for SSE text; got:\n${text}`)), remaining)),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

/** Parse complete SSE frames (event/id/data) out of a text buffer, ignoring comments. */
function frames(text: string): { event?: string; id?: string; data?: string }[] {
  return text
    .split("\n\n")
    .map((block) => {
      const f: { event?: string; id?: string; data?: string } = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) f.event = line.slice(7);
        else if (line.startsWith("id: ")) f.id = line.slice(4);
        else if (line.startsWith("data: ")) f.data = line.slice(6);
      }
      return f;
    })
    .filter((f) => f.event !== undefined);
}

describe("GET /api/bundles", () => {
  it("lists index entries from the web dir and runs/*, deduped by runId and sorted by startedAt", async () => {
    const res = await app().request("/api/bundles");
    expect(res.status).toBe(200);
    const entries = BundleIndexSchema.parse(await res.json());
    const ids = entries.map((e) => e.runId);
    expect(ids.sort()).toEqual(["sample-42", "sample-7", "sample-9"]);
    expect(new Set(ids).size).toBe(ids.length);
    const started = entries.map((e) => Date.parse(e.startedAt));
    expect([...started].sort((a, b) => a - b)).toEqual(started);
  });

  it("allows loopback dashboard origins and no others", async () => {
    const ok = await app().request("/api/bundles", { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(ok.headers.get("Access-Control-Expose-Headers")).toContain(HASH_MISMATCH_HEADER);
    const ip = await app().request("/api/bundles", { headers: { Origin: "http://127.0.0.1:4173" } });
    expect(ip.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:4173");
    const evil = await app().request("/api/bundles", { headers: { Origin: "https://evil.example" } });
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const sneaky = await app().request("/api/bundles", { headers: { Origin: "http://localhost.evil.example" } });
    expect(sneaky.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("is read-only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app().request("/api/bundles/sample-42", { method });
      expect(res.status).toBe(405);
    }
  });
});

describe("GET /api/bundles/:id", () => {
  it("returns a verified bundle", async () => {
    const res = await app().request("/api/bundles/sample-7");
    expect(res.status).toBe(200);
    expect(res.headers.get(HASH_MISMATCH_HEADER)).toBeNull();
    const body = await res.json();
    const checked = verifyBundle(body);
    expect(checked.ok).toBe(true);
    expect((body as { runId: string }).runId).toBe("sample-7");
  });

  it("serves a tampered bundle with the mismatch header and an error field", async () => {
    const res = await app().request("/api/bundles/sample-9");
    expect(res.status).toBe(200);
    expect(res.headers.get(HASH_MISMATCH_HEADER)).toBe("1");
    const body = (await res.json()) as { runId: string; error: string; disclosure: string[] };
    expect(body.runId).toBe("sample-9");
    expect(body.error).toMatch(/content hash mismatch for sample-9/);
    expect(body.disclosure).toContain("edited by hand");
    const { error: _e, ...bundle } = body;
    expect(verifyBundle(bundle)).toMatchObject({ ok: false, reason: "hash" });
  });

  it("404s an unknown id", async () => {
    const res = await app().request("/api/bundles/no-such-run");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/unknown bundle/) });
  });

  it("rejects path traversal", async () => {
    for (const id of ["..%2Fsecret", "..%2F..%2Fsecret", "%2E%2E%2Fsecret", "..%5Csecret", ".secret", "a%2Fb", "%00"]) {
      const res = await app().request(`/api/bundles/${id}`);
      expect(res.status, id).toBe(400);
      expect(await res.text()).not.toContain("do-not-serve");
    }
    // Unencoded dot segments are normalized away by URL parsing and never reach the handler.
    const dots = await app().request("/api/bundles/../../secret.json");
    expect(dots.status).toBe(404);
    expect(await dots.text()).not.toContain("do-not-serve");
  });
});

describe("GET /api/stream", () => {
  it("streams a published event with its type as the event name and the bus id", async () => {
    const bus = new EventBus();
    const res = await app(bus).request("/api/stream");
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    await readUntil(reader, (t) => t.includes(": connected"));
    expect(bus.listenerCount).toBe(1);

    const emitted = bus.emit("probe.committed", { probeId: "p-1", prediction: "h1" });
    const text = await readUntil(reader, (t) => frames(t).length >= 1);
    const [frame] = frames(text);
    expect(frame?.event).toBe("probe.committed");
    expect(frame?.id).toBe(String(emitted.id));
    expect(JSON.parse(frame!.data!)).toEqual({ at: emitted.at, payload: { probeId: "p-1", prediction: "h1" } });
    await reader.cancel();
  });

  it("uses exactly the five TDD event names", async () => {
    const bus = new EventBus();
    const reader = (await app(bus).request("/api/stream")).body!.getReader();
    await readUntil(reader, (t) => t.includes(": connected"));
    const types = ["decision", "probe.committed", "probe.verdict", "belief.changed", "run.finished"] as const;
    for (const t of types) bus.emit(t, { t });
    const text = await readUntil(reader, (t) => frames(t).length >= 5);
    expect(frames(text).map((f) => f.event)).toEqual([...types]);
    expect(() => bus.emit("nope" as never, {})).toThrow(/unknown notary event type/);
    await reader.cancel();
  });

  it("replays buffered events after Last-Event-ID, then continues live without duplicates", async () => {
    const bus = new EventBus();
    const e1 = bus.emit("decision", { n: 1 });
    const e2 = bus.emit("probe.verdict", { n: 2 });
    const e3 = bus.emit("belief.changed", { n: 3 });
    const res = await app(bus).request("/api/stream", { headers: { "Last-Event-ID": String(e1.id) } });
    const reader = res.body!.getReader();
    let text = await readUntil(reader, (t) => frames(t).length >= 2);
    expect(frames(text).map((f) => f.id)).toEqual([String(e2.id), String(e3.id)]);
    const e4 = bus.emit("run.finished", { n: 4 });
    text += await readUntil(reader, (t) => frames(text + t).length >= 3);
    expect(frames(text).map((f) => f.id)).toEqual([String(e2.id), String(e3.id), String(e4.id)]);
    await reader.cancel();
  });

  it("replays everything buffered with ?lastEventId=0, and nothing old without it", async () => {
    const bus = new EventBus();
    bus.emit("decision", { n: 1 });
    bus.emit("decision", { n: 2 });
    const all = (await app(bus).request("/api/stream?lastEventId=0")).body!.getReader();
    expect(frames(await readUntil(all, (t) => frames(t).length >= 2)).map((f) => f.id)).toEqual(["1", "2"]);
    await all.cancel();

    const fresh = (await app(bus).request("/api/stream")).body!.getReader();
    await readUntil(fresh, (t) => t.includes(": connected"));
    bus.emit("decision", { n: 3 });
    const text = await readUntil(fresh, (t) => frames(t).length >= 1);
    expect(frames(text).map((f) => f.id)).toEqual(["3"]);
    await fresh.cancel();
  });

  it("sends keep-alive comments while idle", async () => {
    const reader = (await app(new EventBus(), 20).request("/api/stream")).body!.getReader();
    const text = await readUntil(reader, (t) => t.includes(": keep-alive"));
    expect(text).toContain(": keep-alive\n\n");
    await reader.cancel();
  });

  it("unsubscribes from the bus when the client disconnects", async () => {
    const bus = new EventBus();
    const reader = (await app(bus).request("/api/stream")).body!.getReader();
    await readUntil(reader, (t) => t.includes(": connected"));
    expect(bus.listenerCount).toBe(1);
    await reader.cancel();
    await vi.waitFor(() => expect(bus.listenerCount).toBe(0));
    // Emitting with no subscribers is harmless.
    expect(() => bus.emit("decision", { after: "disconnect" })).not.toThrow();
  });
});

describe("EventBus", () => {
  it("keeps a bounded ring buffer with monotonically increasing ids", () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) bus.emit("decision", { i });
    expect(bus.since().map((e) => e.id)).toEqual([3, 4, 5]);
    expect(bus.since(3).map((e) => e.id)).toEqual([4, 5]);
    expect(bus.lastId).toBe(5);
  });

  it("scrubs secret env values from payloads and snapshots them", () => {
    const secret = "sk_test_abcdef123456";
    const bus = new EventBus(10, { DODO_PAYMENTS_API_KEY: secret, HOME: "/home/x" });
    const payload = { note: `header was Bearer ${secret}`, nested: [{ v: secret }], home: "/home/x" };
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e.payload));
    const event = bus.emit("decision", payload);
    expect(JSON.stringify(event.payload)).not.toContain(secret);
    expect(event.payload).toEqual({ note: "header was Bearer [REDACTED]", nested: [{ v: "[REDACTED]" }], home: "/home/x" });
    expect(seen).toEqual([event.payload]);
    payload.home = "mutated";
    expect((bus.since()[0]!.payload as { home: string }).home).toBe("/home/x");
  });

  it("isolates a throwing listener from the producer and other listeners", () => {
    const bus = new EventBus();
    const got: number[] = [];
    bus.subscribe(() => {
      throw new Error("closed stream");
    });
    bus.subscribe((e) => got.push(e.id));
    expect(() => bus.emit("decision", {})).not.toThrow();
    expect(got).toEqual([1]);
  });
});
