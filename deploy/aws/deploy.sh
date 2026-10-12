#!/usr/bin/env bash
# Deploy the hosted, read-only Notary API (+ Notary Chat agent) to Amazon ECS Express Mode
# (Fargate + an HTTPS Application Load Balancer that ECS provisions). See docs/DEPLOY_AWS.md.
#
#   1. preflight: AWS credentials (BLOCKED, exit 3, if missing), AWS CLI, docker, node
#   2. required secrets exist in Secrets Manager (else BLOCKED: run put-secrets.sh)
#   3. ECR repository, stage real run records, docker build + push (tag = git sha)
#   4. IAM: task execution role (pull image, logs, read notary secrets) + Express infrastructure role
#   5. create or update the Express service; print its HTTPS endpoint
#
# Usage: deploy/aws/deploy.sh [--dry-run]     (--dry-run: steps 1-2 and print the container JSON)
. "$(dirname "$0")/lib.sh"
load_config
require_aws_credentials
require_cmd docker "https://docs.docker.com/get-docker/ (with buildx)"
require_cmd node "Node 22+ renders the task JSON (deploy/aws/render.mjs)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# 2. Secrets: ARNs only (describe-secret never returns a value).
for name in LITELLM_API_KEY LITELLM_BASE_URL NOTARY_HOSTED_TOKEN NEATLOGS_API_KEY; do
  arn="$(aws secretsmanager describe-secret --secret-id "$NOTARY_SECRET_NAME/$name" --query ARN --output text 2>/dev/null || true)"
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    case "$name" in
      NEATLOGS_API_KEY) info "no $NOTARY_SECRET_NAME/$name: tracing off in the hosted API"; continue ;;
      *) blocked "secret $NOTARY_SECRET_NAME/$name not found in Secrets Manager ($AWS_REGION) — run deploy/aws/put-secrets.sh first" ;;
    esac
  fi
  export "SECRET_ARN_$name=$arn"
done
[ -n "${NOTARY_MODEL_CHAT:-}${NOTARY_MODEL_REFLECTOR:-}" ] || blocked "NOTARY_MODEL_CHAT (or NOTARY_MODEL_REFLECTOR) not set in deploy/aws/config.env — the chat agent needs a model"

TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ] && TAG="$TAG-dirty-$(date +%H%M%S)"
export NOTARY_IMAGE="$(ecr_uri):$TAG"

if [ "$DRY" = 1 ]; then
  EXECUTION_ROLE_ARN="arn:aws:iam::$AWS_ACCOUNT_ID:role/${NOTARY_APP}-task-execution" node "$AWS_DIR/render.mjs" container
  info "dry run: nothing created"
  exit 0
fi

# 3. Image.
aws ecr describe-repositories --repository-names "$NOTARY_ECR_REPO" >/dev/null 2>&1 ||
  aws ecr create-repository --repository-name "$NOTARY_ECR_REPO" --image-scanning-configuration scanOnPush=true --image-tag-mutability IMMUTABLE >/dev/null
bash "$AWS_DIR/stage-data.sh"
PLATFORM="linux/amd64"
[ "$NOTARY_CPU_ARCH" = "ARM64" ] && PLATFORM="linux/arm64"
aws ecr get-login-password | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com" >/dev/null
docker buildx build --platform "$PLATFORM" -t "$NOTARY_IMAGE" -f "$REPO_ROOT/Dockerfile" --push "$REPO_ROOT"
info "pushed $NOTARY_IMAGE"

# 4. IAM roles (idempotent).
ensure_role() { # name trust-file managed-policy-arn
  if ! aws iam get-role --role-name "$1" >/dev/null 2>&1; then
    aws iam create-role --role-name "$1" --assume-role-policy-document "file://$2" --tags Key=app,Value="$NOTARY_APP" >/dev/null
    info "created role $1 (IAM is eventually consistent: if the next step says it can't assume it, wait a minute and rerun)"
  fi
  [ -n "${3:-}" ] && aws iam attach-role-policy --role-name "$1" --policy-arn "$3" >/dev/null
  aws iam get-role --role-name "$1" --query Role.Arn --output text
}
path_for_aws() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
EXECUTION_ROLE_ARN="$(ensure_role "${NOTARY_APP}-task-execution" "$(path_for_aws "$AWS_DIR/iam/ecs-tasks-trust.json")" arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy)"
INFRA_ROLE_ARN="$(ensure_role "${NOTARY_APP}-express-infrastructure" "$(path_for_aws "$AWS_DIR/iam/ecs-express-infrastructure-trust.json")" arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices)"
# Read access to this app's secrets only.
POLICY="$(mktemp)"; trap 'rm -f "$POLICY"' EXIT
sed -e "s/__REGION__/$AWS_REGION/g" -e "s/__ACCOUNT__/$AWS_ACCOUNT_ID/g" -e "s#__SECRET_PREFIX__#$NOTARY_SECRET_NAME#g" "$AWS_DIR/iam/read-notary-secrets.json" >"$POLICY"
aws iam put-role-policy --role-name "${NOTARY_APP}-task-execution" --policy-name read-notary-secrets --policy-document "file://$(path_for_aws "$POLICY")" >/dev/null
export EXECUTION_ROLE_ARN
if [ "${NOTARY_LLM_PROVIDER:-litellm}" = "bedrock" ]; then
  TASK_ROLE_ARN="$(ensure_role "${NOTARY_APP}-task" "$(path_for_aws "$AWS_DIR/iam/ecs-tasks-trust.json")")"
  aws iam put-role-policy --role-name "${NOTARY_APP}-task" --policy-name bedrock-invoke --policy-document "file://$(path_for_aws "$AWS_DIR/iam/bedrock-invoke.json")" >/dev/null
  export TASK_ROLE_ARN
fi

aws logs create-log-group --log-group-name "$NOTARY_LOG_GROUP" >/dev/null 2>&1 || true
aws logs put-retention-policy --log-group-name "$NOTARY_LOG_GROUP" --retention-in-days 30 >/dev/null
aws ecs describe-clusters --clusters "$NOTARY_CLUSTER" --query 'clusters[?status==`ACTIVE`].clusterName' --output text | grep -q . ||
  aws ecs create-cluster --cluster-name "$NOTARY_CLUSTER" >/dev/null

# 5. The Express service (create once, update afterwards).
SCALING="minTaskCount=$NOTARY_MIN_TASKS,maxTaskCount=$NOTARY_MAX_TASKS,autoScalingMetric=REQUEST_COUNT_PER_TARGET,autoScalingTargetValue=50"
SERVICE_ARN="$(aws ecs describe-services --cluster "$NOTARY_CLUSTER" --services "$NOTARY_SERVICE" --query 'services[?status==`ACTIVE`].serviceArn' --output text 2>/dev/null || true)"
if [ -n "${NOTARY_EFS_ID:-}" ]; then
  # Shared runs on EFS (agents task writes, API reads): Express Mode with our own task definition.
  TD="$(mktemp)"; node "$AWS_DIR/render.mjs" api-taskdef >"$TD"
  TASKDEF_ARN="$(aws ecs register-task-definition --cli-input-json "file://$(path_for_aws "$TD")" --query taskDefinition.taskDefinitionArn --output text)"
  rm -f "$TD"
  ARGS=(--task-definition-arn "$TASKDEF_ARN")
else
  CONTAINER="$(node "$AWS_DIR/render.mjs" container)"
  ARGS=(--primary-container "$CONTAINER" --execution-role-arn "$EXECUTION_ROLE_ARN" --cpu "$NOTARY_CPU" --memory "$NOTARY_MEMORY" --cpu-architecture "$NOTARY_CPU_ARCH")
  [ -n "${TASK_ROLE_ARN:-}" ] && ARGS+=(--task-role-arn "$TASK_ROLE_ARN")
fi
if [ -z "$SERVICE_ARN" ] || [ "$SERVICE_ARN" = "None" ]; then
  aws ecs create-express-gateway-service --cluster "$NOTARY_CLUSTER" --service-name "$NOTARY_SERVICE" \
    --infrastructure-role-arn "$INFRA_ROLE_ARN" --health-check-path /ping --scaling-target "$SCALING" \
    "${ARGS[@]}" --monitor-resources DEPLOYMENT --monitor-mode TEXT-ONLY >/dev/null
  SERVICE_ARN="$(aws ecs describe-services --cluster "$NOTARY_CLUSTER" --services "$NOTARY_SERVICE" --query 'services[0].serviceArn' --output text)"
  info "created $SERVICE_ARN"
else
  aws ecs update-express-gateway-service --service-arn "$SERVICE_ARN" --health-check-path /ping --scaling-target "$SCALING" \
    "${ARGS[@]}" --monitor-resources DEPLOYMENT --monitor-mode TEXT-ONLY >/dev/null
  info "updated $SERVICE_ARN"
fi
ENDPOINT="$(aws ecs describe-express-gateway-service --service-arn "$SERVICE_ARN" --query 'service.activeConfigurations[0].ingressPaths[0].endpoint' --output text 2>/dev/null || true)"
info "endpoint: ${ENDPOINT:-(see the ECS console)}  — check: curl -s https://<endpoint>/ping"
