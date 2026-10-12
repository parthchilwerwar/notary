/**
 * deploy/aws: every script stops with BLOCKED (exit 3) before touching AWS when no credentials are
 * configured, and the rendered task JSON references secrets by ARN only (never a value). Runs the
 * real scripts with an empty HOME and no AWS_* variables; nothing here can reach AWS.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const AWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../deploy/aws");
const home = mkdtempSync(join(tmpdir(), "notary-aws-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The environment with every AWS credential source removed and an empty HOME. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^AWS_/.test(k)) env[k] = v;
  return { ...env, HOME: home, USERPROFILE: home, NOTARY_AWS_CONFIG: join(home, "none.env"), ...extra };
}

const bash = (script: string, args: string[] = [], env = cleanEnv()) => spawnSync("bash", [join(AWS_DIR, script), ...args], { env, encoding: "utf8", timeout: 60_000 });

describe("deploy/aws BLOCKED without credentials", { timeout: 60_000 }, () => {
  for (const [script, args] of [
    ["deploy.sh", []],
    ["put-secrets.sh", []],
    ["run-agents.sh", ["notarize", "--tool", "crustdata"]],
  ] as const) {
    it(`${script} exits 3 with "BLOCKED: AWS credentials not set"`, () => {
      const r = bash(script, [...args]);
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/^BLOCKED: AWS credentials not set/m);
    });
  }

  it("a key without its secret is still not credentials", () => {
    const r = bash("deploy.sh", [], cleanEnv({ AWS_ACCESS_KEY_ID: "test-key-id-only" }));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("BLOCKED: AWS credentials not set");
  });
});

describe("render.mjs", { timeout: 60_000 }, () => {
  const render = (what: string, extra: Record<string, string>) => spawnSync(process.execPath, [join(AWS_DIR, "render.mjs"), what], { env: { ...cleanEnv(), ...extra }, encoding: "utf8" });
  const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:notary/prod/LITELLM_API_KEY-AbCdEf";

  it("container: image, port 8080, settings as env, secrets by ARN only", () => {
    const r = render("container", { NOTARY_IMAGE: "123456789012.dkr.ecr.us-east-1.amazonaws.com/notary:abc", SECRET_ARN_LITELLM_API_KEY: ARN, NOTARY_MODEL_REFLECTOR: "claude-haiku", NOTARY_MAX_USD: "0.25" });
    expect(r.status).toBe(0);
    const c = JSON.parse(r.stdout) as { containerPort: number; secrets: { name: string; valueFrom: string }[]; environment: { name: string; value: string }[] };
    expect(c.containerPort).toBe(8080);
    expect(c.secrets).toEqual([{ name: "LITELLM_API_KEY", valueFrom: ARN }]);
    expect(c.environment).toEqual(expect.arrayContaining([{ name: "NOTARY_MODE", value: "test" }, { name: "NOTARY_MAX_USD", value: "0.25" }, { name: "NOTARY_RUNS_DIR", value: "/app/data/runs" }]));
    // The read-only site gets no Crustdata/Dodo keys even if their ARNs exist.
    const r2 = render("container", { NOTARY_IMAGE: "x:y", SECRET_ARN_DODO_PAYMENTS_API_KEY: ARN });
    expect((JSON.parse(r2.stdout) as { secrets: unknown[] }).secrets).toEqual([]);
  });

  it("agent-taskdef: the agents container, Dodo test mode fixed, EFS only when configured", () => {
    const r = render("agent-taskdef", { NOTARY_IMAGE: "x:y", EXECUTION_ROLE_ARN: "arn:aws:iam::1:role/r", AWS_REGION: "us-east-1", SECRET_ARN_DODO_PAYMENTS_API_KEY: ARN });
    expect(r.status).toBe(0);
    const td = JSON.parse(r.stdout) as { volumes?: unknown; containerDefinitions: { name: string; environment: { name: string; value: string }[]; secrets: unknown[] }[] };
    expect(td.volumes).toBeUndefined();
    expect(td.containerDefinitions[0]!.name).toBe("agents");
    expect(td.containerDefinitions[0]!.environment).toEqual(expect.arrayContaining([{ name: "NOTARY_MODE", value: "test" }, { name: "DODO_BASE_URL", value: "https://test.dodopayments.com" }]));
    expect(td.containerDefinitions[0]!.secrets).toEqual([{ name: "DODO_PAYMENTS_API_KEY", valueFrom: ARN }]);
  });
});
