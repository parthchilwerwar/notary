# Deploying Notary's agents to AWS

Status: **prepared, not yet run against AWS.** Every script stops with `BLOCKED: AWS credentials not set` (exit 3) until credentials exist. Nothing in this repo has created an AWS resource yet. The container entry point (`src/hosted-main.ts`) has been run locally against the real LiteLLM proxy, but the Docker image itself has not been built on this machine: the Docker daemon wasn't running.

## What runs where

| Agent | Model role (env) | Where it runs on AWS |
|---|---|---|
| Notary Chat | `chat` (`NOTARY_MODEL_CHAT`, falls back to `NOTARY_MODEL_REFLECTOR`) | **API service**, always on: ECS Express Mode (Fargate + HTTPS load balancer) |
| Executor (Ask Notary's model role) | `executor` | API service (`POST /api/ask`) |
| Reflector, Adversary, Executor (queue) | `reflector`, `adversary` | **Agents task**: a one-off ECS Fargate task (`notary notarize` / `notary run`) started by `deploy/aws/run-agents.sh` |
| Guard | none (a deterministic rule) | Runs inside the processes above |

The models are reached through the LiteLLM proxy, the same as on your laptop. AWS hosts the agents' code and loop, not the models. If you later set `NOTARY_LLM_PROVIDER=bedrock`, `deploy.sh` also creates a task role with `bedrock:InvokeModel`.

## Why ECS Express Mode

- **App Runner is out.** AWS closed it to new customers on 2026-04-30 and points new projects to ECS Express Mode ([availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)).
- **Express Mode fits the API.** One `create-express-gateway-service` call gets you an ECS service on Fargate, an internet-facing ALB with TLS at `https://<service>.ecs.<region>.on.aws/`, autoscaling, CloudWatch logs and canary rollbacks. ECS secrets come from Secrets Manager. Long-lived SSE streams work through an ALB.
- **AgentCore Runtime is a poor fit for now.** Bedrock AgentCore Runtime wants a container that serves `POST /invocations` and `GET /ping` on port 8080, built for **ARM64**, with inbound auth through IAM SigV4 or JWT ([service contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html)). Notary's API is a multi-route REST + SSE server with conversation state, a read-only dashboard API and a separate batch-agent workload. Fitting it into AgentCore would mean an adapter for each agent and a JWT issuer. Express Mode runs the existing server unchanged. If AgentCore becomes a requirement, the chat loop (`src/chat/agent.ts`) is the piece to wrap behind `/invocations`.

## Security design (the hosted site is read-only)

- **No approvals.** `GET/POST /api/approvals/**` are not mounted (404). `POST /api/runs` returns 405. Chat's `list_approvals` and `get_approval` report "unavailable" on the hosted site, so even a read-only view of held actions is off.
- **Ask and chat need a bearer token.** `NOTARY_HOSTED_TOKEN` is at least 32 characters. `put-secrets.sh` generates it with `openssl rand -base64 48` and stores it in Secrets Manager as `notary/prod/NOTARY_HOSTED_TOKEN`. ECS injects it at task start. The server compares it in constant time, and it is never logged or put in a span. The localhost + session-token rule of `notary serve` is unchanged. Hosted mode is a separate entry point (`src/hosted-main.ts`), not a flag on `serve`.
- **Read endpoints stay open**, as they are locally: bundles, runs, certificates, timelines, health and `/ping`. They serve hash-verified real bundles only.
- **CORS:** exactly the origins in `NOTARY_ALLOWED_ORIGINS`. Each must be https; plain http is accepted only for localhost.
- **Secrets never touch the image.** `.dockerignore` excludes `.env`. `put-secrets.sh` creates one Secrets Manager secret per variable, passing each value through a 0600 temp file that it deletes right after; a value is never echoed or put on a command line. `deploy.sh` reads only secret **ARNs** (`describe-secret`), never values. The execution role may read `notary/prod/*` and nothing else.
- **The API task gets only what it needs:** `LITELLM_API_KEY`, `LITELLM_BASE_URL`, `NOTARY_HOSTED_TOKEN`, and optionally `NEATLOGS_API_KEY`. Crustdata and Dodo keys go only to the agents task, so chat's live lookups say "Not connected" on the hosted site.
- **Spend caps:** `NOTARY_MAX_USD` (default `0.25` in `config.env`) caps model spend per chat message and per agents run. `NOTARY_ASK_RPM` limits chat messages per minute per task. The process-wide `NOTARY_LLM_RPM` / `NOTARY_LLM_CONCURRENCY` limiter applies to every model call.
- **Dodo stays in test mode:** `NOTARY_MODE=test` and the test base URL are fixed in the agents task definition.

## Files

| File | What it does |
|---|---|
| `Dockerfile` | Two stages, `node:22.20.0-bookworm-slim`, pnpm 11.7.0 via corepack. Installs only `@notary/core` from the frozen lockfile and runs as the `node` user. Default `CMD` is the hosted API on :8080. |
| `.dockerignore` | Keeps `.env`, `node_modules`, local `runs/`, SQLite files and docs out of the build context. |
| `deploy/aws/config.env.example` | Names, sizes and model ids. No secrets. Copy it to `config.env`. |
| `deploy/aws/lib.sh` | Preflight: credentials (BLOCKED, exit 3), AWS CLI, region, `sts get-caller-identity`. |
| `deploy/aws/put-secrets.sh` | `.env` → Secrets Manager, one secret per variable. Generates `NOTARY_HOSTED_TOKEN`. |
| `deploy/aws/stage-data.sh` | Copies the real run bundles (`<id>.json`, `index.json`, `timeline.jsonl`) into `deploy/aws/data/runs`, which is gitignored and baked into the image. |
| `deploy/aws/deploy.sh` | ECR repo, image build and push, IAM roles, log group, cluster, then creates or updates the Express service. |
| `deploy/aws/run-agents.sh` | Runs `notary notarize` / `notary run` as a Fargate task. |
| `deploy/aws/render.mjs` | Renders the container and task-definition JSON. Secrets are referenced by ARN only. |
| `deploy/aws/iam/*.json` | Trust policies, the secrets read policy, and the optional Bedrock policy. |

## Steps (when credentials arrive)

Prerequisites: AWS CLI v2, Docker with buildx, Node 22+, `openssl`, and an IAM principal that may manage ECR, ECS, IAM roles, Secrets Manager, CloudWatch Logs and EC2 describe calls.

1. **Credentials.** Use SSO (`aws configure sso && aws sso login --profile notary && export AWS_PROFILE=notary`) or export `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`. Then `export AWS_REGION=us-east-1`. Never put AWS keys in `.env` or `config.env`.
2. **Config.** Run `cp deploy/aws/config.env.example deploy/aws/config.env`, then set the model ids (as `pnpm notary doctor --llm` lists them), `NOTARY_MODEL_CHAT` (recommended: `claude-sonnet-4.6`, see below) and `NOTARY_ALLOWED_ORIGINS`.
3. **Check locally first.** Run `pnpm notary doctor --llm`. It must end with `result: OK — Executor, Reflector, Adversary and Notary Chat answered`, which includes a real tool call by the chat model.
4. **Secrets.** Run `bash deploy/aws/put-secrets.sh`. Afterwards, read the hosted token for your client with `aws secretsmanager get-secret-value --secret-id notary/prod/NOTARY_HOSTED_TOKEN --query SecretString --output text`.
5. **Dry run.** `bash deploy/aws/deploy.sh --dry-run` checks credentials and secrets and prints the container JSON (ARNs only). It creates nothing.
6. **Deploy.** Run `bash deploy/aws/deploy.sh`. It prints the endpoint. Then check it:
   ```bash
   curl -s https://<endpoint>/ping                       # {"status":"Healthy"}
   curl -s https://<endpoint>/api/health                 # integrations + agents with their models
   TOKEN=$(aws secretsmanager get-secret-value --secret-id notary/prod/NOTARY_HOSTED_TOKEN --query SecretString --output text)
   CONV=$(curl -s -X POST https://<endpoint>/api/chat -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' | jq -r .conversation.id)
   curl -N -X POST https://<endpoint>/api/chat/$CONV/messages -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"content":"Which certificates exist?"}'
   curl -s -o /dev/null -w '%{http_code}\n' https://<endpoint>/api/approvals   # 404 (read-only site)
   ```
7. **Batch agents.** For example `bash deploy/aws/run-agents.sh notarize --tool crustdata`. The script prints the log-tail and wait commands.
8. **Redeploy** after code or data changes: rerun `deploy.sh`. It builds a new immutable tag (the git sha) and runs `update-express-gateway-service`. **Rotate** the hosted token with `put-secrets.sh --rotate-hosted-token`, then `deploy.sh`.
9. **Tear down:**
   ```bash
   aws ecs delete-express-gateway-service --service-arn <arn>
   aws ecr delete-repository --repository-name notary --force
   aws secretsmanager delete-secret --secret-id notary/prod/<VAR> --recovery-window-in-days 7   # per secret
   aws iam detach-role-policy / delete-role-policy / delete-role                               # notary-task-execution, notary-express-infrastructure
   ```

### Shared runs on EFS (optional)

By default the API serves the runs baked into the image, and an agents task's `runs/` is ephemeral: the script warns about this before it starts. To share runs, create an encrypted EFS file system in the VPC with mount targets in the task subnets and a security group that allows NFS (2049) from the tasks. Then set `NOTARY_EFS_ID` (and optionally `NOTARY_EFS_ACCESS_POINT`) in `config.env` and rerun `deploy.sh`. The API then uses its own task definition (container `Main`) with the volume mounted **read-only** at `/mnt/notary-runs`. The agents task mounts the same volume read-write as its `runs/`. The EFS resources themselves are not scripted.

## Chat model recommendation

`claude-haiku` passes the tool-calling doctor check and answers single-step questions well. In the local end-to-end test, though, it stopped early on a two-part money question: it refused the money part, as it should, but didn't call a tool for the second part. `claude-sonnet-4.6` answered both parts with valid certificate citations for about $0.03. So the recommendation is `NOTARY_MODEL_CHAT=claude-sonnet-4.6`; the user's `.env` already has that line commented out.

## Docs vs reality (record in docs/DECISIONS.md)

- The ECS Express getting-started guide shows `--cpu 2 --memory 4` (vCPU / GB). The CLI reference documents CPU units and MiB, with defaults of `256` / `512`. The scripts use units: `1024` / `2048`. Check on the first real run.
- The guide's prose says Express Mode defaults to 1 vCPU / 2 GB, while the CLI reference says 256 / 512. The scripts always pass explicit values.
- The infrastructure role's trust principal is `ecs.amazonaws.com`, and its managed policy is `AmazonECSInfrastructureRoleforExpressGatewayServices` (lower-case "for"), as in the getting-started guide.
- Converse has no `"none"` tool choice and requires `toolConfig` whenever the history holds tool blocks. On Bedrock, the chat loop sends `auto` together with the "answer now" nudge when it hits the step cap.
- AgentCore's contract requires ARM64. This image builds for `X86_64` by default; set `NOTARY_CPU_ARCH=ARM64` for Graviton.
