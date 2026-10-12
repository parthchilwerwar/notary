/**
 * The real Bedrock transport's client options (audit #6): the SDK must not retry on its own (our
 * limiter and USD-cap check run per attempt) and every request has a timeout. The AWS SDK module is
 * a TEST DOUBLE here (vi.mock); nothing touches the network.
 */
import { describe, expect, it, vi } from "vitest";

const constructed: Record<string, unknown>[] = [];
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    constructor(config: Record<string, unknown>) {
      constructed.push(config);
    }
    async send() {
      return { output: { message: { role: "assistant", content: [{ text: "ok" }] } }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" };
    }
  },
  ConverseCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

describe("bedrockTransport", () => {
  it("builds the client with maxAttempts 1 and a request timeout", async () => {
    const { bedrockTransport, BEDROCK_REQUEST_TIMEOUT_MS } = await import("../src/llm/client.js");
    const send = bedrockTransport("us-east-1");
    await send({ modelId: "m", messages: [] } as never);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ region: "us-east-1", maxAttempts: 1, requestHandler: { requestTimeout: BEDROCK_REQUEST_TIMEOUT_MS } });
    expect(BEDROCK_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
