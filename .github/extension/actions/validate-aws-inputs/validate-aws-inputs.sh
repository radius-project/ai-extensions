#!/bin/bash
# Offline checks of the AWS workflow inputs. They run before any AWS call, so a
# malformed variable fails in about a second with a coded error that names it,
# instead of minutes later inside a Radius step. Every problem is reported
# before the script exits, so one run lists everything to fix.
#
# Inputs (environment):
#   AWS_ROLE_ARN, AWS_ACCOUNT_ID, AWS_REGION,
#   AWS_EKS_CLUSTER_NAME                      required
#   RADIUS_SUBNET_IDS                         checked when set, required when REQUIRE_SUBNETS=true
#   RECIPE_PACK_URL, RECIPE_PACK_REF          checked when either is set
#   RAD_COMMANDS                              optional; a command or a JSON array of commands
#   APP_FILE                                  checked when set and RAD_COMMANDS is blank
#   RADIUS_DEPLOY_PARAMS                      optional; must be exactly one JSON object, and is never printed
#
# Needs jq. Exit codes: 0 pass, 1 one or more problems.
set -uo pipefail

here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=.github/extension/scripts/workflow-annotations.sh
source "$here/../../scripts/workflow-annotations.sh"
# shellcheck source=.github/extension/actions/run-rad-commands/allowed-commands.sh
source "$here/../run-rad-commands/allowed-commands.sh"

problems=0
VARS_FIX="in this GitHub environment's variables"

invalid() {
  # invalid <message> <fix>
  annotate error INPUT_INVALID "Invalid workflow input" "$1" "$2"
  problems=$((problems + 1))
}

# check <name> <value> <required> <pattern> <expected shape>
check() {
  local name=$1 value=$2 required=$3 pattern=$4 shape=$5
  if [[ -z "$value" ]]; then
    [[ "$required" != true ]] || invalid "$name is not set." "Set $name $VARS_FIX to $shape, or rerun environment setup in Radius Canvas."
    return 0
  fi
  [[ "$value" =~ $pattern ]] || invalid "$name '$value' is not $shape." "Correct $name $VARS_FIX, or rerun environment setup in Radius Canvas."
}

check AWS_ROLE_ARN "${AWS_ROLE_ARN:-}" true '^arn:aws(-cn|-us-gov)?:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$' \
  "an IAM role ARN such as arn:aws:iam::123456789012:role/radius-deploy"
check AWS_ACCOUNT_ID "${AWS_ACCOUNT_ID:-}" true '^[0-9]{12}$' "a 12-digit AWS account ID"
# The same patterns Canvas setup validates the region and cluster with.
check AWS_REGION "${AWS_REGION:-}" true '^[a-z]{2}(-gov)?-[a-z]+-[0-9]$' "an AWS Region such as us-east-2"
check AWS_EKS_CLUSTER_NAME "${AWS_EKS_CLUSTER_NAME:-}" true '^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$' "an EKS cluster name"
check RADIUS_SUBNET_IDS "${RADIUS_SUBNET_IDS:-}" "${REQUIRE_SUBNETS:-false}" '^subnet-[0-9a-f]+(,subnet-[0-9a-f]+)*$' \
  "a comma-separated list of subnet IDs such as subnet-0abc,subnet-0def"

# The aws-eks recipes are tagged with the contrib commit that published them,
# so the pack and its recipes must come from the same commit.
pack_url="${RECIPE_PACK_URL:-}"
pack_ref="${RECIPE_PACK_REF:-}"
if [[ -n "$pack_url$pack_ref" ]]; then
  if ! [[ "$pack_ref" =~ ^[0-9a-f]{40}$ ]] || [[ "$pack_url" != https://*"/${pack_ref}/"* ]]; then
    invalid "The provider recipe pack URL must be an https URL that contains its 40-character commit, but this workflow has URL '$pack_url' and commit '$pack_ref'." \
      "Commit the current Radius AWS workflow templates, which pin the recipe pack and its commit together."
  fi
fi

rad_commands="${RAD_COMMANDS:-}"
commands=()
if [[ -n "${rad_commands//[[:space:]]/}" ]]; then
  # Parsed the way run-rad-commands parses it: a JSON array, or one command string.
  if printf '%s' "$rad_commands" | jq -e 'type == "array"' >/dev/null 2>&1; then
    while IFS= read -r cmd; do
      commands+=("$cmd")
    done < <(printf '%s' "$rad_commands" | jq -r '.[]')
  else
    commands=("$rad_commands")
  fi
  for cmd in "${commands[@]}"; do
    [[ -n "${cmd//[[:space:]]/}" ]] || continue
    if ! is_allowed "$cmd"; then
      # Only the first word is printed, because a command can carry a secret parameter.
      annotate error INPUT_COMMAND_NOT_ALLOWED "rad command not allowed" \
        "The rad command '${cmd%% *}' is not allowed in this workflow." \
        "Use only these rad commands: ${ALLOWED_VERBS// /, }."
      problems=$((problems + 1))
    fi
  done
elif [[ -n "${APP_FILE:-}" && ! -f "$APP_FILE" ]]; then
  annotate error INPUT_APP_FILE_MISSING "Application file missing" \
    "The application file '$APP_FILE' is not in the commit this workflow checked out." \
    "Ask Copilot to create it, commit and push it to the deployed branch, then deploy again."
  problems=$((problems + 1))
fi

# Slurping makes jq read every JSON value in the secret, so a stream such as
# '{} {}' or whitespace alone is rejected instead of judged by its last value.
deploy_params="${RADIUS_DEPLOY_PARAMS:-}"
if [[ -n "$deploy_params" ]] &&
  ! printf '%s' "$deploy_params" | jq -se 'length == 1 and (.[0] | type) == "object"' >/dev/null 2>&1; then
  annotate error INPUT_DEPLOY_PARAMS_INVALID "Deploy parameters are not a JSON object" \
    "The RADIUS_DEPLOY_PARAMS secret is set but is not exactly one JSON object." \
    "Set the secret to a JSON object of parameter names and values, or delete it."
  problems=$((problems + 1))
fi

if ((problems > 0)); then
  echo "Found $problems invalid input(s). Nothing was changed." >&2
  exit 1
fi
echo "Workflow inputs are valid."
