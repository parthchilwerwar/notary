/**
 * Every BLOCKED message about models / the LLM backend names the exact env variable and points to
 * `pnpm notary doctor --llm`. Transports here are TEST DOUBLES; nothing reaches a provider.
 */
import { describe, expect, it } from "vitest";
import { LlmClient, llmConfigIssues, requireModel, resolveModels } from "../src/llm/index.js";
import { preflight } from "../src/reflect/notarize.js";
import { isBlocked } from "../src/tools/errors.js";

const DOCTOR = "`pnpm notary doctor --llm`";
const ask = { role: "executor" as const, messages: [{ role: "user" as const, content: "x" }] };

async function blockedMessage(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isBlocked(err)).toBe(true);
  return (err as Error).message;
}

describe("LLM BLOCKED messages", () => {
  it("a missing role model names its variable and the doctor", () => {
    let msg = "";
    try {
      requireModel(resolveModels({}), "adversary");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(`BLOCKED: NOTARY_MODEL_ADVERSARY not set — set it in .env (see .env.example) and run ${DOCTOR}`);
  });

  it("missing provider settings name their variable and the doctor (both providers)", async () => {
    const m = { NOTARY_MODEL_EXECUTOR: "m" };
    expect(await blockedMessage(new LlmClient({ env: m }).complete(ask))).toBe(
      `BLOCKED: AWS_REGION not set — set it in .env (see .env.example) and run ${DOCTOR}`,
    );
    const lite = { ...m, NOTARY_LLM_PROVIDER: "litellm" };
    expect(await blockedMessage(new LlmClient({ env: lite }).complete(ask))).toBe(
      `BLOCKED: LITELLM_BASE_URL not set — set it in .env (see .env.example) and run ${DOCTOR}`,
    );
    expect(await blockedMessage(new LlmClient({ env: { ...lite, LITELLM_BASE_URL: "https://p.example" } }).complete(ask))).toBe(
      `BLOCKED: LITELLM_API_KEY not set — set it in .env (see .env.example) and run ${DOCTOR}`,
    );
    expect(await blockedMessage(new LlmClient({ env: { ...lite, LITELLM_BASE_URL: "nope", LITELLM_API_KEY: "placeholder-key" } }).complete(ask))).toBe(
      `BLOCKED: LITELLM_BASE_URL is not an http(s) URL — fix it in .env (see .env.example) and run ${DOCTOR}`,
    );
  });

  it("missing AWS credentials name the variables and the LiteLLM alternative", async () => {
    const llm = new LlmClient({
      env: { NOTARY_MODEL_EXECUTOR: "m", AWS_REGION: "us-east-1" },
      transport: async () => {
        throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
      },
    });
    const msg = await blockedMessage(llm.complete(ask));
    expect(msg).toMatch(/^BLOCKED: AWS credentials \(env keys or AWS_PROFILE\/SSO\) not set — set AWS_ACCESS_KEY_ID \+ AWS_SECRET_ACCESS_KEY/);
    expect(msg).toContain("NOTARY_LLM_PROVIDER=litellm");
    expect(msg).toContain(DOCTOR);
  });

  it("notarize preflight lists each missing model setting with the fix, provider-aware", () => {
    const lines = preflight({ tool: "crustdata", replay: true }, { NOTARY_LLM_PROVIDER: "litellm" } as NodeJS.ProcessEnv).result!.lines;
    expect(lines).toEqual(
      ["NOTARY_MODEL_REFLECTOR", "LITELLM_BASE_URL", "LITELLM_API_KEY"].map(
        (v) => `BLOCKED: ${v} not set — set it in .env (see .env.example) and run ${DOCTOR}`,
      ),
    );
    for (const i of llmConfigIssues({}, "executor")) expect(i.message).toContain(DOCTOR);
  });

  it("separation of duties names the variable to change and the doctor", () => {
    expect(() => resolveModels({ NOTARY_MODEL_REFLECTOR: "a", NOTARY_MODEL_ADVERSARY: "a" })).toThrow(
      /Set NOTARY_MODEL_ADVERSARY to a different model and run `pnpm notary doctor --llm`/,
    );
  });
});
