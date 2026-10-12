#!/usr/bin/env bash
# Run Notary's batch agents (Executor, Reflector, Adversary — they work inside `notary notarize` and
# `notary run`) as a one-off ECS Fargate task from the same image, in the same cluster.
#
#   deploy/aws/run-agents.sh notarize --tool crustdata
#   deploy/aws/run-agents.sh notarize --tool dodo --priors-from <runId>
#   deploy/aws/run-agents.sh run --queue packages/core/fixtures/queue/seeded.json
#
# The arguments after the script name are passed to the Notary CLI unchanged. Secrets (model proxy,
# Crustdata, Dodo test key, neatlogs) come from Secrets Manager; Dodo stays in test mode
# (NOTARY_MODE=test and the test base URL are fixed in the task definition).
#
# Persistence: with NOTARY_EFS_ID set (config.env), runs/ is an EFS volume shared with the API, so a
# finished bundle shows up on the hosted site. Without it the task's runs/ is ephemeral and the
# script says so before starting — nothing is silently lost.
. "$(dirname "$0")/lib.sh"
load_config
require_aws_credentials
require_cmd node "Node 22+ renders the task JSON (deploy/aws/render.mjs)"
[ "$#" -gt 0 ] || fail "usage: deploy/aws/run-agents.sh <notary command and args>, e.g. notarize --tool crustdata"
case "$1" in
  notarize|run|replay|eval|guards|doctor) ;;
  serve) fail "serve is the API service (deploy/aws/deploy.sh), not an agents task" ;;
  *) fail "unsupported command '$1' (notarize, run, replay, eval, guards, doctor)" ;;
esac

for name in LITELLM_API_KEY LITELLM_BASE_URL NEATLOGS_API_KEY CRUSTDATA_API_KEY DODO_PAYMENTS_API_KEY; do
  arn="$(aws secretsmanager describe-secret --secret-id "$NOTARY_SECRET_NAME/$name" --query ARN --output text 2>/dev/null || true)"
  if [ -n "$arn" ] && [ "$arn" != "None" ]; then export "SECRET_ARN_$name=$arn"; else info "no $NOTARY_SECRET_NAME/$name: the step that needs it will print BLOCKED"; fi
done

TAG="${NOTARY_IMAGE_TAG:-$(aws ecr describe-images --repository-name "$NOTARY_ECR_REPO" --query 'sort_by(imageDetails,& imagePushedAt)[-1].imageTags[0]' --output text)}"
[ -n "$TAG" ] && [ "$TAG" != "None" ] || blocked "no image in ECR repository $NOTARY_ECR_REPO — run deploy/aws/deploy.sh first"
export NOTARY_IMAGE="$(ecr_uri):$TAG"
EXECUTION_ROLE_ARN="$(aws iam get-role --role-name "${NOTARY_APP}-task-execution" --query Role.Arn --output text 2>/dev/null)" || blocked "role ${NOTARY_APP}-task-execution missing — run deploy/aws/deploy.sh first"
export EXECUTION_ROLE_ARN
TASK_ROLE_ARN="$(aws iam get-role --role-name "${NOTARY_APP}-task" --query Role.Arn --output text 2>/dev/null || true)"
[ -n "$TASK_ROLE_ARN" ] && export TASK_ROLE_ARN

path_for_aws() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
TD="$(mktemp)"; trap 'rm -f "$TD"' EXIT
node "$AWS_DIR/render.mjs" agent-taskdef >"$TD"
TASKDEF_ARN="$(aws ecs register-task-definition --cli-input-json "file://$(path_for_aws "$TD")" --query taskDefinition.taskDefinitionArn --output text)"

# Network: the default VPC's subnets unless NOTARY_SUBNETS / NOTARY_SECURITY_GROUPS are set.
if [ -z "${NOTARY_SUBNETS:-}" ]; then
  VPC="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
  [ "$VPC" != "None" ] || blocked "no default VPC in $AWS_REGION — set NOTARY_SUBNETS and NOTARY_SECURITY_GROUPS in config.env"
  NOTARY_SUBNETS="$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true --query 'Subnets[].SubnetId' --output text | tr '\t' ',')"
fi
NET="awsvpcConfiguration={subnets=[$NOTARY_SUBNETS],assignPublicIp=ENABLED${NOTARY_SECURITY_GROUPS:+,securityGroups=[$NOTARY_SECURITY_GROUPS]}}"

[ -n "${NOTARY_EFS_ID:-}" ] || info "NOTARY_EFS_ID not set: this task's runs/ is EPHEMERAL — its bundle is only in the task logs' summary, not on the hosted site (docs/DEPLOY_AWS.md, 'Shared runs on EFS')"
OVERRIDES="$(node -e 'const a=process.argv.slice(1); console.log(JSON.stringify({containerOverrides:[{name:"agents",command:["node","--import","tsx","packages/core/src/cli.ts",...a]}]}))' "$@")"
TASK_ARN="$(aws ecs run-task --cluster "$NOTARY_CLUSTER" --launch-type FARGATE --task-definition "$TASKDEF_ARN" \
  --network-configuration "$NET" --overrides "$OVERRIDES" --started-by notary-run-agents --query 'tasks[0].taskArn' --output text)"
info "started $TASK_ARN"
info "follow it: aws logs tail $NOTARY_LOG_GROUP --follow --log-stream-name-prefix agents"
info "wait:      aws ecs wait tasks-stopped --cluster $NOTARY_CLUSTER --tasks $TASK_ARN && aws ecs describe-tasks --cluster $NOTARY_CLUSTER --tasks $TASK_ARN --query 'tasks[0].containers[0].exitCode'"
