#!/usr/bin/env bash
# Store Notary's secrets in AWS Secrets Manager, one secret per variable: <NOTARY_SECRET_NAME>/<VAR>
# (default notary/prod/LITELLM_API_KEY, ...). Values are read from the repo's .env (or the current
# environment, which wins) and handed to the AWS CLI through a 0600 temp file that is deleted right
# after — never echoed, never on a command line, never in the image.
#
# NOTARY_HOSTED_TOKEN (the bearer token for the hosted ask/chat API) is generated here with
# `openssl rand` when it doesn't exist yet. Read it back yourself when you need it:
#   aws secretsmanager get-secret-value --secret-id notary/prod/NOTARY_HOSTED_TOKEN --query SecretString --output text
#
# Usage: deploy/aws/put-secrets.sh            (create missing / update changed)
#        deploy/aws/put-secrets.sh --rotate-hosted-token
. "$(dirname "$0")/lib.sh"
load_config
require_aws_credentials

VARS=(LITELLM_API_KEY LITELLM_BASE_URL NEATLOGS_API_KEY CRUSTDATA_API_KEY DODO_PAYMENTS_API_KEY)
ROTATE=0
[ "${1:-}" = "--rotate-hosted-token" ] && ROTATE=1

# Read one variable's value: the environment first, else the repo .env (KEY=VALUE lines, no export).
value_of() {
  local name="$1" line v=""
  if [ -n "${!name:-}" ]; then printf '%s' "${!name}"; return; fi
  if [ -f "$REPO_ROOT/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      case "$line" in "$name="*) v="${line#"$name="}" ;; esac
    done <"$REPO_ROOT/.env"
  fi
  v="${v%\"}"; v="${v#\"}"
  printf '%s' "$v"
}

TMP="$(mktemp)"
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT
file_uri() {
  if command -v cygpath >/dev/null 2>&1; then echo "file://$(cygpath -m "$TMP")"; else echo "file://$TMP"; fi
}

put() {
  local name="$1" id="$NOTARY_SECRET_NAME/$1"
  if aws secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$id" --secret-string "$(file_uri)" >/dev/null
    info "updated $id"
  else
    aws secretsmanager create-secret --name "$id" --description "Notary $name (deploy/aws/put-secrets.sh)" --secret-string "$(file_uri)" --tags Key=app,Value="$NOTARY_APP" >/dev/null
    info "created $id"
  fi
  : >"$TMP"
}

for name in "${VARS[@]}"; do
  v="$(value_of "$name")"
  if [ -z "$v" ]; then
    info "skip $name (not set locally; the tool that needs it reports 'unavailable')"
    continue
  fi
  printf '%s' "$v" >"$TMP"
  unset v
  put "$name"
done

HOSTED_ID="$NOTARY_SECRET_NAME/NOTARY_HOSTED_TOKEN"
if [ "$ROTATE" = 1 ] || ! aws secretsmanager describe-secret --secret-id "$HOSTED_ID" >/dev/null 2>&1; then
  require_cmd openssl "needed to generate NOTARY_HOSTED_TOKEN"
  openssl rand -base64 48 | tr -d '\n' >"$TMP"
  put NOTARY_HOSTED_TOKEN
  info "NOTARY_HOSTED_TOKEN generated (not shown); redeploy (deploy/aws/deploy.sh) so running tasks pick it up"
else
  info "kept $HOSTED_ID (use --rotate-hosted-token to replace it)"
fi
