#!/bin/bash
# Fails unless the signed-in AWS role is in the environment's AWS account.
#
# Inputs (environment):
#   ENVIRONMENT_ACCOUNT_ID      the GitHub environment's AWS_ACCOUNT_ID, which
#                               validate-aws-inputs has already checked
#
# Exit codes: 0 the accounts match, 1 otherwise.
set -uo pipefail

here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=.github/extension/scripts/workflow-annotations.sh
source "$here/../../scripts/workflow-annotations.sh"

environment_account=${ENVIRONMENT_ACCOUNT_ID:-}
if ! role_account=$(aws sts get-caller-identity --cli-connect-timeout 5 --cli-read-timeout 10 \
  --query Account --output text); then
  annotate error AWS_IDENTITY_UNAVAILABLE "AWS identity unavailable" \
    "aws sts get-caller-identity failed for AWS_ROLE_ARN." \
    "Read the AWS error above, then rerun the workflow."
  exit 1
fi
if ! [[ "$role_account" =~ ^[0-9]{12}$ ]]; then
  annotate error AWS_IDENTITY_UNAVAILABLE "AWS identity unavailable" \
    "aws sts get-caller-identity returned no account for AWS_ROLE_ARN." \
    "Rerun the workflow."
  exit 1
fi
if [[ "$role_account" != "$environment_account" ]]; then
  annotate error AWS_ACCOUNT_MISMATCH "AWS account mismatch" \
    "AWS_ROLE_ARN is in AWS account $role_account, but AWS_ACCOUNT_ID is $environment_account." \
    "Change AWS_ROLE_ARN or AWS_ACCOUNT_ID in this GitHub environment's variables so both name the same account."
  exit 1
fi
echo "AWS_ROLE_ARN is in AWS account $role_account, matching AWS_ACCOUNT_ID."
