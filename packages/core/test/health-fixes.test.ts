import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, emitEvent, setEventJournal, tailEventJournal } from "../src/api/bus.js";
import { buildProgram } from "../src/cli.js";

const line = (rec: unknown) => JSON.stringify(rec) + "\n";

describe("cross-process event journal (Step 1: SSE never saw events from a separate `notary run`)", () => {
  afterEach(() => setEventJournal(null));

  it("emitEvent appends to the journal only when one is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "notary-journal-"));
    const path = join(dir, "events.jsonl");
    emitEvent("decision", { id: "before" });
    setEventJournal(path);
    emitEvent("decision", { id: "d1" });
    const recs = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ pid: process.pid, type: "decision", payload: { id: "d1" } });
  });

  it("the server-side tail re-emits other processes' events, skips its own, and starts at the end of the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "notary-journal-"));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, line({ pid: 999_001, type: "decision", payload: { old: true } }));
    const target = new EventBus();
    const tail = tailEventJournal(path, target, 60_000);
    appendFileSync(path, line({ pid: 999_001, type: "run.finished", payload: { runId: "r1" } }));
    appendFileSync(path, line({ pid: process.pid, type: "decision", payload: { mine: true } }));
    appendFileSync(path, line({ pid: 999_001, type: "not.a.type", payload: {} }) + "{broken json\n");
    tail.poll();
    tail.stop();
    expect(target.since().map((e) => [e.type, e.payload])).toEqual([["run.finished", { runId: "r1" }]]);
  });

  it("buffers a partial trailing line until it is completed, and survives truncation", () => {
    const dir = mkdtempSync(join(tmpdir(), "notary-journal-"));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "");
    const target = new EventBus();
    const tail = tailEventJournal(path, target, 60_000);
    const full = line({ pid: 999_002, type: "probe.committed", payload: { probeId: "p1" } });
    appendFileSync(path, full.slice(0, 20));
    tail.poll();
    expect(target.since()).toHaveLength(0);
    appendFileSync(path, full.slice(20));
    tail.poll();
    expect(target.since().map((e) => e.payload)).toEqual([{ probeId: "p1" }]);
    writeFileSync(path, line({ pid: 999_002, type: "belief.changed", payload: { beliefId: "b1" } }));
    tail.poll();
    tail.stop();
    expect(target.since().map((e) => e.type)).toEqual(["probe.committed", "belief.changed"]);
  });
});

describe("notary doctor (Step 1: exited 1 with JSON instead of BLOCKED exit 3)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("prints BLOCKED and exits 3 when NEATLOGS_API_KEY is not set", async () => {
    vi.stubEnv("NEATLOGS_API_KEY", "");
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    await buildProgram().parseAsync(["node", "notary", "doctor"]);
    expect(process.exitCode).toBe(3);
    expect(errors.join("\n")).toMatch(/^BLOCKED: NEATLOGS_API_KEY not set/m);
  });
});
