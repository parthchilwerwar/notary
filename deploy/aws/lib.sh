#!/usr/bin/env bash
# Shared helpers for deploy/aws/*.sh. Sourced, never run directly.
# Repo convention: a missing prerequisite is BLOCKED (exit 3) with the reason; a real failure is exit 1.
# Nothing here prints a secret: values are piped, never echoed or put on a command line.

set -euo pipefail

AWS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$AWS_DIR/../.." && pwd)"

blocked() {
  echo "BLOCKED: $*" >&2
  exit 3
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

info() { echo "notary-aws: $*"; }

# Load deploy/aws/config.env (names and sizes only — no secrets live there).
load_config() {
  local cfg="${NOTARY_AWS_CONFIG:-$AWS_DIR/config.env}"
  if [ -f "$cfg" ]; then
    # shellcheck disable=SC1090
    set -a; . "$cfg"; set +a
  fi
  : "${AWS_REGION:=${AWS_DEFAULT_REGION:-}}"
  : "${NOTARY_APP:=notary}"
  : "${NOTARY_ECR_REPO:=notary}"
  : "${NOTARY_CLUSTER:=notary}"
  : "${NOTARY_SERVICE:=notary-api}"
  : "${NOTARY_SECRET_NAME:=notary/prod}"
  : "${NOTARY_CPU:=1024}"
  : "${NOTARY_MEMORY:=2048}"
  : "${NOTARY_CPU_ARCH:=X86_64}"
  : "${NOTARY_MIN_TASKS:=1}"
  : "${NOTARY_MAX_TASKS:=2}"
  : "${NOTARY_MAX_USD:=0.25}"
  : "${NOTARY_ASK_RPM:=10}"
  : "${NOTARY_LOG_GROUP:=/ecs/notary}"
  export AWS_REGION
}

# AWS credentials must be present before anything talks to AWS. Checked without calling AWS first:
# env keys, a named profile, web identity / container credentials, or a shared config/credentials file.
require_aws_credentials() {
  local have=""
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && have="env"
  [ -z "$have" ] && [ -n "${AWS_PROFILE:-}" ] && have="profile"
  [ -z "$have" ] && [ -n "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && have="web-identity"
  [ -z "$have" ] && { [ -n "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] || [ -n "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ]; } && have="container"
  [ -z "$have" ] && { [ -f "${AWS_SHARED_CREDENTIALS_FILE:-${HOME:-/nonexistent}/.aws/credentials}" ] || [ -f "${AWS_CONFIG_FILE:-${HOME:-/nonexistent}/.aws/config}" ]; } && have="shared-file"
  if [ -z "$have" ]; then
    blocked "AWS credentials not set — export AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_PROFILE / aws sso login) and AWS_REGION, then rerun (docs/DEPLOY_AWS.md)"
  fi
  command -v aws >/dev/null 2>&1 || blocked "AWS CLI v2 not installed — https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  [ -n "${AWS_REGION:-}" ] || blocked "AWS_REGION not set — set it in deploy/aws/config.env or export it (e.g. AWS_REGION=us-east-1)"
  if ! AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"; then
    blocked "AWS credentials not set or not valid (aws sts get-caller-identity failed; source: $have) — refresh them (aws sso login / new keys) and rerun"
  fi
  export AWS_ACCOUNT_ID
  info "account $AWS_ACCOUNT_ID, region $AWS_REGION (credentials: $have)"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || blocked "$1 not installed — $2"
}

ecr_uri() { echo "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$NOTARY_ECR_REPO"; }
secret_arn() { aws secretsmanager describe-secret --secret-id "$NOTARY_SECRET_NAME" --query ARN --output text 2>/dev/null; }
