/**
 * Adversary tests. Beliefs, claims, probes, hypotheses and model replies here are hand-built TEST
 * DATA. The Bedrock transport, the `claude` session runner and the git runner are TEST DOUBLES:
 * nothing reaches AWS, no Claude Code session is spawned and the real repo's history is untouched.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoReflectorProse,
  buildEvidencePacket,
  claudeArgs,
  parseReviewerText,
  reviewBelief,
} from "../src/adversary/index.js";
import type { EvidencePacket, GitRunner, SessionRunner } from "../src/adversary/index.js";
import { LlmClient } from "../src/llm/index.js";
import type { ConverseTransport } from "../src/llm/index.js";
import { AdversaryReviewSchema } from "../src/schema/belief.js";
import type { Belief, Claim, Hypothesis, Probe } from "../src/schema/index.js";

const ENV = {
  AWS_REGION: "us-east-1",
  NOTARY_MODEL_REFLECTOR: "anthropic.claude-sonnet-4-20250514-v1:0",
  NOTARY_MODEL_ADVERSARY: "anthropic.claude-opus-4-1-20250805-v1:0",
};

const REFLECTOR_PROSE = "TEST-REFLECTOR-PROSE the API silently clamps page_size because of a CDN cache";

const claim: Claim = {
  id: "test-claim-page-size",
  tool: "dodo",
  operation: "listRefunds",
  param: "page_size",
  docText: "test doc text: page_size up to 100",
  expect: { kind: "maxItems", max: 100 },
  docUrl: "https://example.test/docs",
  endpoint: "GET /refunds",
};

const hypotheses: Hypothesis[] = [
  {
    id: "hyp-aaaaaaaaaaaa",
    anomalyId: "test-anomaly-1",
    class: "silent_truncation",
    statement: REFLECTOR_PROSE,
    distinguishingTest: "boundary_sweep",
  },
  {
    id: "hyp-bbbbbbbbbbbb",
    anomalyId: "test-anomaly-1",
    class: "honored",
    statement: "TEST-REFLECTOR-PROSE the limit is honored",
    distinguishingTest: "boundary_sweep",
  },
];

function probe(id: string, committedAt: string, extra: Partial<Probe> = {}): Probe {
  return {
    id,
    tool: "dodo",
    claimId: claim.id,
    hypothesisIds: hypotheses.map((h) => h.id),
    template: "boundary_sweep",
    params: { steps: [{ op: "listRefunds", params: { page_size: 101 } }] },
    control: { params: { steps: [{ op: "listRefunds", params: { page_size: 100 } }] }, observed: { count: 100 } },
    prediction: {
      // A prediction value smuggling the hypothesis statement: it must never reach the packet.
      [hypotheses[0]!.id]: { class: "silent_truncation", outcomes: ["clamped"], statement: hypotheses[0]!.statement },
      [hypotheses[1]!.id]: { class: "honored", outcomes: ["rejected"], explanation: "TEST-REFLECTOR-PROSE x", rationale: "y" },
    },
    predictionHash: "a".repeat(64),
    committedAt,
    ranAt: committedAt,
    observed: { outcome: "clamped", count: 100 },
    verdict: "confirmed",
    winningHypothesisId: hypotheses[0]!.id,
    costCredits: 0,
    calls: 2,
    traceId: `trace-${id}`,
    spanId: `span-${id}`,
    ...extra,
  };
}

const probes: Probe[] = [
  probe("test-probe-2", "2026-10-10T10:05:00.000Z"),
  probe("test-probe-1", "2026-10-10T10:00:00.000Z"),
  probe("test-probe-other-claim", "2026-10-10T10:01:00.000Z", { claimId: "some-other-claim" }),
];

const belief: Belief = {
  id: "test-belief-1",
  claimId: claim.id,
  tool: "dodo",
  class: "silent_truncation",
  statement: "listRefunds clamps page_size above 100 to 100 without an error",
  alpha: 1,
  beta: 3,
  confidence: 0.0625,
  status: "candidate",
  evidence: [
    { probeId: "test-probe-1", traceId: "trace-test-probe-1", spanId: "span-test-probe-1" },
    { probeId: "test-probe-2", traceId: "trace-test-probe-2" },
  ],
  updatedAt: "2026-10-10T10:06:00.000Z",
};

function transportReturning(text: string, calls: unknown[] = []): ConverseTransport {
  return async (input) => {
    calls.push(input);
    return {
      output: { message: { role: "assistant", content: [{ text }] } },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      stopReason: "end_turn",
      metrics: { latencyMs: 1 },
      $metadata: {},
    } as unknown as ConverseCommandOutput;
  };
}

const NOW = new Date("2026-10-10T11:00:00.000Z");

describe("evidence packet", () => {
  it("excludes reflector prose and keeps class + predicted outcomes", () => {
    const { packet, json } = buildEvidencePacket({ belief, claim, probes, env: {} });
    for (const h of hypotheses) expect(json).not.toContain(h.statement);
    expect(json).not.toContain("TEST-REFLECTOR-PROSE");
    expect(json).not.toContain('"explanation"');
    expect(json).not.toContain('"rationale"');
    // the only "statement" key is the belief's own
    expect(json.match(/"statement"/g)).toHaveLength(1);
    expect(packet.belief.statement).toBe(belief.statement);

    const p1 = packet.probes[0]!;
    expect(p1.predictions).toEqual([
      { hypothesisId: "hyp-aaaaaaaaaaaa", class: "silent_truncation", predicted: ["clamped"] },
      { hypothesisId: "hyp-bbbbbbbbbbbb", class: "honored", predicted: ["rejected"] },
    ]);
    expect(p1.control).toEqual({ params: probes[1]!.control!.params, observed: { count: 100 } });
    expect(p1).toMatchObject({ template: "boundary_sweep", verdict: "confirmed", costCredits: 0, calls: 2 });
  });

  it("is deterministic, ordered by commit time, and limited to the belief's claim", () => {
    const a = buildEvidencePacket({ belief, claim, probes, env: {} }).json;
    const b = buildEvidencePacket({ belief, claim, probes: [...probes].reverse(), env: {} }).json;
    expect(a).toBe(b);
    const { packet } = buildEvidencePacket({ belief, claim, probes, env: {} });
    expect(packet.probes.map((p) => p.id)).toEqual(["test-probe-1", "test-probe-2"]);
    expect(packet.probes.every((p) => p.cited)).toBe(true);
    expect(packet.probes[1]!.spanId).toBe("span-test-probe-2");
  });

  it("scrubs secret-looking env values", () => {
    const secret = "sk_test_TESTSECRETVALUE123";
    const leaky = [probe("test-probe-1", "2026-10-10T10:00:00.000Z", { observed: { echo: `key=${secret}` } })];
    const { json } = buildEvidencePacket({ belief, claim, probes: leaky, env: { DODO_PAYMENTS_API_KEY: secret } });
    expect(json).not.toContain(secret);
    expect(json).toContain("[REDACTED]");
  });

  it("assertNoReflectorProse throws on a prose field in predictions", () => {
    const { packet } = buildEvidencePacket({ belief, claim, probes, env: {} });
    const tampered = structuredClone(packet) as EvidencePacket;
    (tampered.probes[0]!.predictions[0] as unknown as Record<string, unknown>).statement = "prose";
    expect(() => assertNoReflectorProse(tampered)).toThrow(/reflector prose/);
  });
});

describe("reply parsing", () => {
  it("rejects narrow without scope and accepts null optionals", () => {
    expect(parseReviewerText('{"verdict":"narrow","reason":"r"}').ok).toBe(false);
    const ok = parseReviewerText('{"verdict":"uphold","reason":"r","scope":null,"untestedAlternative":null}');
    expect(ok.ok).toBe(true);
  });
});

describe("bedrock backend", () => {
  it("returns a validated review for a valid reply, using role adversary", async () => {
    const calls: { modelId?: string; system?: { text?: string }[]; messages?: { content?: { text?: string }[] }[] }[] = [];
    const llm = new LlmClient({
      env: ENV,
      transport: transportReturning(
        '{"verdict":"narrow","reason":"Only one API key was used.","scope":"test-mode key, listRefunds only","untestedAlternative":"per-account limit"}',
        calls as unknown[],
      ),
    });
    const out = await reviewBelief({ belief, claim, probes, backend: "bedrock", llm });
    expect(out.failure).toBeUndefined();
    expect(AdversaryReviewSchema.parse(out.review)).toEqual(out.review);
    expect(out.review).toMatchObject({
      verdict: "narrow",
      model: ENV.NOTARY_MODEL_ADVERSARY,
      backend: "bedrock",
      scope: "test-mode key, listRefunds only",
    });
    expect(out.review!.reason).toContain("Untested alternative: per-account limit");
    expect(calls[0]!.modelId).toBe(ENV.NOTARY_MODEL_ADVERSARY);
    const sent = JSON.stringify(calls[0]);
    expect(sent).not.toContain("TEST-REFLECTOR-PROSE");
    expect(llm.meter.snapshot().adversary.calls).toBe(1);
    expect(llm.meter.snapshot().reflector.calls).toBe(0);
  });

  it("accepts JSON wrapped in prose / code fences", async () => {
    const llm = new LlmClient({
      env: ENV,
      transport: transportReturning('Here is my review:\n```json\n{"verdict":"downgrade","reason":"Control varied a different param."}\n```\nThanks.'),
    });
    const out = await reviewBelief({ belief, claim, probes, backend: "bedrock", llm });
    expect(out.review).toMatchObject({ verdict: "downgrade", reason: "Control varied a different param." });
  });

  it.each([
    ["no JSON", "I think the belief is fine."],
    ["bad verdict", '{"verdict":"approve","reason":"x"}'],
    ["empty reason", '{"verdict":"uphold","reason":""}'],
    ["truncated", '{"verdict":"uphold","reason":"cut off'],
  ])("fails safe on malformed output (%s)", async (_label, text) => {
    const llm = new LlmClient({ env: ENV, transport: transportReturning(text) });
    const out = await reviewBelief({ belief, claim, probes, backend: "bedrock", llm });
    expect(out.review).toBeNull();
    expect(out.failure).toMatch(/adversary \(bedrock\)/);
  });

  it("fails safe on a non-credential transport error", async () => {
    const llm = new LlmClient({
      env: ENV,
      transport: async () => {
        throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      },
    });
    const out = await reviewBelief({ belief, claim, probes, backend: "bedrock", llm });
    expect(out.review).toBeNull();
    expect(out.failure).toContain("ThrottlingException");
  });

  it("propagates BLOCKED when the adversary model id is missing", async () => {
    const llm = new LlmClient({ env: { AWS_REGION: "us-east-1" }, transport: transportReturning("{}") });
    await expect(reviewBelief({ belief, claim, probes, backend: "bedrock", llm })).rejects.toThrow(
      "BLOCKED: NOTARY_MODEL_ADVERSARY not set",
    );
  });

  it("propagates BLOCKED on missing AWS credentials", async () => {
    const llm = new LlmClient({
      env: ENV,
      transport: async () => {
        throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
      },
    });
    await expect(reviewBelief({ belief, claim, probes, backend: "bedrock", llm })).rejects.toThrow(/^BLOCKED:/);
  });
});

describe("session backend", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function tempRepo(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "notary-adversary-"));
    dirs.push(d);
    return d;
  }

  function fakeGit(calls: { args: string[]; cwd: string }[], fail = false): GitRunner {
    return async (args, cwd) => {
      calls.push({ args, cwd });
      return { exitCode: fail ? 1 : 0, stdout: "", stderr: fail ? "fatal: test double" : "" };
    };
  }

  function runnerWriting(content: string | null, stdout: string, seen: Parameters<SessionRunner>[0][] = []): SessionRunner {
    return async (req) => {
      seen.push(req);
      if (content !== null) await writeFile(join(req.cwd, "adversary", "verdicts", `${belief.id}.json`), content, "utf8");
      return { exitCode: 0, stdout, stderr: "" };
    };
  }

  const SESSION_STDOUT = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "test-session-0001",
  });

  it("writes the inbox, validates the verdict, captures the session id and commits both paths", async () => {
    const repo = await tempRepo();
    const seen: Parameters<SessionRunner>[0][] = [];
    const gitCalls: { args: string[]; cwd: string }[] = [];
    const out = await reviewBelief({
      belief,
      claim,
      probes,
      backend: "session",
      repoRoot: repo,
      sessionRunner: runnerWriting('{"verdict":"uphold","reason":"Control and treatment differ only in page_size."}', SESSION_STDOUT, seen),
      gitRunner: fakeGit(gitCalls),
    });
    expect(out.failure).toBeUndefined();
    expect(AdversaryReviewSchema.parse(out.review)).toEqual(out.review);
    expect(out.review).toMatchObject({
      verdict: "uphold",
      model: "claude-code-session",
      backend: "session",
      sessionId: "test-session-0001",
    });

    const inbox = await readFile(join(repo, "adversary", "inbox", `${belief.id}.json`), "utf8");
    expect(inbox).toBe(`${buildEvidencePacket({ belief, claim, probes }).json}\n`);
    expect(inbox).not.toContain("TEST-REFLECTOR-PROSE");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.command).toBe("claude");
    expect(seen[0]!.cwd).toBe(repo);
    expect(seen[0]!.args).toEqual(claudeArgs(belief.id));
    expect(seen[0]!.args).toContain("--output-format");
    expect(seen[0]!.args.join(" ")).toContain(`Read(./adversary/inbox/${belief.id}.json),Edit(./adversary/verdicts/${belief.id}.json)`);

    const paths = [`adversary/verdicts/${belief.id}.json`, `adversary/inbox/${belief.id}.json`];
    expect(gitCalls).toEqual([
      { args: ["add", "--", ...paths], cwd: repo },
      { args: ["commit", "-m", `adversary: uphold ${belief.id}`, "--", ...paths], cwd: repo },
    ]);
  });

  it("does not commit when commit is false", async () => {
    const repo = await tempRepo();
    const gitCalls: { args: string[]; cwd: string }[] = [];
    const out = await reviewBelief({
      belief,
      claim,
      probes,
      backend: "session",
      repoRoot: repo,
      commit: false,
      sessionRunner: runnerWriting('{"verdict":"downgrade","reason":"r"}', SESSION_STDOUT),
      gitRunner: fakeGit(gitCalls),
    });
    expect(out.review?.verdict).toBe("downgrade");
    expect(gitCalls).toHaveLength(0);
  });

  it("strips tool secrets from the child env", async () => {
    const repo = await tempRepo();
    const seen: Parameters<SessionRunner>[0][] = [];
    const prev = process.env.DODO_PAYMENTS_API_KEY;
    process.env.DODO_PAYMENTS_API_KEY = "sk_test_TESTSECRETVALUE123";
    try {
      await reviewBelief({
        belief,
        claim,
        probes,
        backend: "session",
        repoRoot: repo,
        commit: false,
        sessionRunner: runnerWriting('{"verdict":"uphold","reason":"r"}', SESSION_STDOUT, seen),
      });
    } finally {
      if (prev === undefined) delete process.env.DODO_PAYMENTS_API_KEY;
      else process.env.DODO_PAYMENTS_API_KEY = prev;
    }
    expect(seen[0]!.env.DODO_PAYMENTS_API_KEY).toBeUndefined();
    expect(seen[0]!.args.join(" ")).not.toContain("sk_test_TESTSECRETVALUE123");
  });

  it.each([
    ["missing verdict file", null, /no verdict file/],
    ["invalid JSON", "{not json", /not valid JSON/],
    ["schema violation", '{"verdict":"maybe","reason":"x"}', /failed validation/],
    ["narrow without scope", '{"verdict":"narrow","reason":"x"}', /failed validation/],
  ])("returns null on %s and does not commit", async (_label, content, failure) => {
    const repo = await tempRepo();
    const gitCalls: { args: string[]; cwd: string }[] = [];
    const out = await reviewBelief({
      belief,
      claim,
      probes,
      backend: "session",
      repoRoot: repo,
      sessionRunner: runnerWriting(content, SESSION_STDOUT),
      gitRunner: fakeGit(gitCalls),
    });
    expect(out.review).toBeNull();
    expect(out.failure).toMatch(failure);
    expect(gitCalls).toHaveLength(0);
  });

  it("never reads a stale verdict from an earlier run", async () => {
    const repo = await tempRepo();
    const first = await reviewBelief({
      belief,
      claim,
      probes,
      backend: "session",
      repoRoot: repo,
      commit: false,
      sessionRunner: runnerWriting('{"verdict":"uphold","reason":"r"}', SESSION_STDOUT),
    });
    expect(first.review?.verdict).toBe("uphold");
    const second = await reviewBelief({
      belief,
      claim,
      probes,
      backend: "session",
      repoRoot: repo,
      commit: false,
      sessionRunner: runnerWriting(null, SESSION_STDOUT),
    });
    expect(second.review).toBeNull();
    expect(existsSync(join(repo, "adversary", "verdicts", `${belief.id}.json`))).toBe(false);
  });

  it("fails safe on non-zero exit, error result, timeout, thrown runner and git failure", async () => {
    const repo = await tempRepo();
    const base = { belief, claim, probes, backend: "session" as const, repoRoot: repo };
    const verdict = '{"verdict":"uphold","reason":"r"}';

    const exit1 = await reviewBelief({ ...base, sessionRunner: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }) });
    expect(exit1).toMatchObject({ review: null });
    expect(exit1.failure).toContain("exited with 1");

    const errResult = await reviewBelief({
      ...base,
      sessionRunner: runnerWriting(verdict, JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s" })),
    });
    expect(errResult.review).toBeNull();
    expect(errResult.failure).toContain("error result");

    const timedOut = await reviewBelief({
      ...base,
      sessionRunner: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
    });
    expect(timedOut.failure).toContain("timed out");

    const thrown = await reviewBelief({
      ...base,
      sessionRunner: async () => {
        throw new Error("spawn claude ENOENT");
      },
    });
    expect(thrown.failure).toContain("ENOENT");

    const gitFail = await reviewBelief({
      ...base,
      sessionRunner: runnerWriting(verdict, SESSION_STDOUT),
      gitRunner: fakeGit([], true),
    });
    expect(gitFail.review).toBeNull();
    expect(gitFail.failure).toContain("git add failed");
  });

  it("rejects an unsafe belief id without running anything", async () => {
    const repo = await tempRepo();
    const seen: Parameters<SessionRunner>[0][] = [];
    const out = await reviewBelief({
      belief: { ...belief, id: "../escape" },
      claim,
      probes,
      backend: "session",
      repoRoot: repo,
      sessionRunner: runnerWriting(null, SESSION_STDOUT, seen),
    });
    expect(out.review).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
