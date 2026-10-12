#!/usr/bin/env node
// Render the JSON documents deploy/aws/*.sh pass to the AWS CLI. Pure: reads only the environment
// variables named below (names, ARNs and sizes — never a secret value) and prints JSON to stdout.
//
//   node render.mjs container   -> --primary-container for create/update-express-gateway-service
//   node render.mjs api-taskdef -> register-task-definition input for the API (only with NOTARY_EFS_ID)
//   node render.mjs agent-taskdef -> register-task-definition input for one agents task
//
// Secrets are referenced by ARN (ECS injects them at task start from AWS Secrets Manager); a secret
// whose ARN variable is empty is simply not mapped (e.g. no NEATLOGS_API_KEY -> tracing off).

const env = process.env;
const need = (name) => {
  const v = (env[name] ?? "").trim();
  if (!v) {
    console.error(`render.mjs: ${name} is required`);
    process.exit(2);
  }
  return v;
};

/** Secrets for the hosted API: model proxy, hosted token, tracing. No Crustdata/Dodo keys on the read-only site. */
const API_SECRETS = ["LITELLM_API_KEY", "LITELLM_BASE_URL", "NOTARY_HOSTED_TOKEN", "NEATLOGS_API_KEY"];
/** Secrets for the agents task (notarize / run need the tool APIs too). */
const AGENT_SECRETS = ["LITELLM_API_KEY", "LITELLM_BASE_URL", "NEATLOGS_API_KEY", "CRUSTDATA_API_KEY", "DODO_PAYMENTS_API_KEY"];

/** ARN of each secret, passed in as SECRET_ARN_<NAME> by the shell scripts (describe-secret, no value read). */
const secrets = (names) =>
  names.flatMap((name) => {
    const arn = (env[`SECRET_ARN_${name}`] ?? "").trim();
    return arn ? [{ name, valueFrom: arn }] : [];
  });

/** Non-secret settings, from deploy/aws/config.env (model ids are configuration, not secrets). */
const settings = (extra = []) =>
  [
    ["NOTARY_LLM_PROVIDER", env.NOTARY_LLM_PROVIDER || "litellm"],
    ["NOTARY_MODEL_EXECUTOR", env.NOTARY_MODEL_EXECUTOR],
    ["NOTARY_MODEL_REFLECTOR", env.NOTARY_MODEL_REFLECTOR],
    ["NOTARY_MODEL_ADVERSARY", env.NOTARY_MODEL_ADVERSARY],
    ["NOTARY_MODEL_CHAT", env.NOTARY_MODEL_CHAT],
    ["NOTARY_MAX_USD", env.NOTARY_MAX_USD],
    ["NOTARY_ASK_RPM", env.NOTARY_ASK_RPM],
    ["NOTARY_LLM_RPM", env.NOTARY_LLM_RPM],
    ["NOTARY_LLM_CONCURRENCY", env.NOTARY_LLM_CONCURRENCY],
    ["NOTARY_MODE", "test"],
    ["NODE_ENV", "production"],
    ...extra,
  ]
    .filter(([, v]) => v !== undefined && String(v).trim() !== "")
    .map(([name, value]) => ({ name, value: String(value) }));

const logs = (prefix) => ({ logGroup: env.NOTARY_LOG_GROUP || "/ecs/notary", logStreamPrefix: prefix });

const runsDir = env.NOTARY_EFS_ID ? "/mnt/notary-runs" : "/app/data/runs";

function container() {
  return {
    image: need("NOTARY_IMAGE"),
    containerPort: 8080,
    awsLogsConfiguration: logs("api"),
    environment: settings([
      ["PORT", "8080"],
      ["NOTARY_RUNS_DIR", runsDir],
      ["NOTARY_ALLOWED_ORIGINS", env.NOTARY_ALLOWED_ORIGINS],
    ]),
    secrets: secrets(API_SECRETS),
  };
}

const efsVolume = () => ({
  name: "notary-runs",
  efsVolumeConfiguration: {
    fileSystemId: need("NOTARY_EFS_ID"),
    transitEncryption: "ENABLED",
    ...(env.NOTARY_EFS_ACCESS_POINT ? { authorizationConfig: { accessPointId: env.NOTARY_EFS_ACCESS_POINT, iam: "ENABLED" } } : {}),
  },
});

function apiTaskDef() {
  const c = container();
  return {
    family: `${env.NOTARY_APP || "notary"}-api`,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: env.NOTARY_CPU || "1024",
    memory: env.NOTARY_MEMORY || "2048",
    runtimePlatform: { cpuArchitecture: env.NOTARY_CPU_ARCH || "X86_64", operatingSystemFamily: "LINUX" },
    executionRoleArn: need("EXECUTION_ROLE_ARN"),
    ...(env.TASK_ROLE_ARN ? { taskRoleArn: env.TASK_ROLE_ARN } : {}),
    volumes: [efsVolume()],
    containerDefinitions: [
      {
        // Express Mode requires the container to be named "Main" with one named TCP port mapping.
        name: "Main",
        image: c.image,
        essential: true,
        portMappings: [{ name: "http", containerPort: 8080, protocol: "tcp" }],
        environment: c.environment,
        secrets: c.secrets,
        // The hosted API only reads runs.
        mountPoints: [{ sourceVolume: "notary-runs", containerPath: "/mnt/notary-runs", readOnly: true }],
        logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": logs("api").logGroup, "awslogs-region": need("AWS_REGION"), "awslogs-stream-prefix": "api" } },
      },
    ],
  };
}

function agentTaskDef() {
  return {
    family: `${env.NOTARY_APP || "notary"}-agents`,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: env.NOTARY_AGENT_CPU || "1024",
    memory: env.NOTARY_AGENT_MEMORY || "2048",
    runtimePlatform: { cpuArchitecture: env.NOTARY_CPU_ARCH || "X86_64", operatingSystemFamily: "LINUX" },
    executionRoleArn: need("EXECUTION_ROLE_ARN"),
    ...(env.TASK_ROLE_ARN ? { taskRoleArn: env.TASK_ROLE_ARN } : {}),
    ...(env.NOTARY_EFS_ID ? { volumes: [efsVolume()] } : {}),
    containerDefinitions: [
      {
        name: "agents",
        image: need("NOTARY_IMAGE"),
        essential: true,
        // The Executor / Reflector / Adversary run inside `notary notarize` and `notary run`; the command is set per run-task.
        command: ["node", "--import", "tsx", "packages/core/src/cli.ts", "--help"],
        environment: settings([["CRUSTDATA_CREDIT_BUDGET", env.CRUSTDATA_CREDIT_BUDGET], ["DODO_BASE_URL", "https://test.dodopayments.com"]]),
        secrets: secrets(AGENT_SECRETS),
        ...(env.NOTARY_EFS_ID ? { mountPoints: [{ sourceVolume: "notary-runs", containerPath: "/app/packages/core/runs", readOnly: false }] } : {}),
        logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": logs("agents").logGroup, "awslogs-region": need("AWS_REGION"), "awslogs-stream-prefix": "agents" } },
      },
    ],
  };
}

const what = process.argv[2];
const out = what === "container" ? container() : what === "api-taskdef" ? apiTaskDef() : what === "agent-taskdef" ? agentTaskDef() : null;
if (!out) {
  console.error("usage: node render.mjs container|api-taskdef|agent-taskdef");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
