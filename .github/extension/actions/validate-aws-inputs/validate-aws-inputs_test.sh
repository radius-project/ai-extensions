#!/bin/bash
# Tests validate-aws-inputs.sh with real jq and no network.
# Run: bash .github/extension/actions/validate-aws-inputs/validate-aws-inputs_test.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp" || exit 1
mkdir -p .radius && printf 'extension radius\n' >.radius/app.bicep

ref=0123456789abcdef0123456789abcdef01234567
valid=(
  AWS_ROLE_ARN=arn:aws:iam::123456789012:role/radius-deploy
  AWS_ACCOUNT_ID=123456789012
  AWS_REGION=us-east-2
  AWS_EKS_CLUSTER_NAME=radius-lab
  "RADIUS_SUBNET_IDS=subnet-0abc,subnet-0def"
  REQUIRE_SUBNETS=true
  RECIPE_PACK_URL="https://raw.githubusercontent.com/radius-project/resource-types-contrib/$ref/pack.bicep"
  "RECIPE_PACK_REF=$ref"
  APP_FILE=.radius/app.bicep
)

pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

# run <var=value>... : runs the script with the valid inputs plus overrides.
run() {
  out=$(env -i PATH="$PATH" "${valid[@]}" "$@" bash "$here/validate-aws-inputs.sh" 2>&1)
  status=$?
}

# expect_code <name> <code> <count> <var=value>...
expect_code() {
  local name=$1 code=$2 count=$3
  shift 3
  run "$@"
  local got
  got=$(grep -c "^::error title=[^:]*::\[$code\] " <<<"$out")
  if [[ "$status" -eq 1 && "$got" -eq "$count" ]]; then ok "$name"; else bad "$name (status $status, $got x $code)"; printf '%s\n' "$out"; fi
}

expect_pass() {
  local name=$1
  shift
  run "$@"
  if [[ "$status" -eq 0 ]] && ! grep -q '^::error' <<<"$out"; then ok "$name"; else bad "$name (status $status)"; printf '%s\n' "$out"; fi
}

delete=(REQUIRE_SUBNETS= RADIUS_SUBNET_IDS= RECIPE_PACK_URL= RECIPE_PACK_REF= APP_FILE=)

expect_pass "deploy inputs pass"
expect_pass "delete without subnets passes" "${delete[@]}"
expect_pass "allowed rad commands pass, app file not needed" 'RAD_COMMANDS=["app list", "", "resource list Radius.Data/redisCaches"]' APP_FILE=missing.bicep
expect_pass "one allowed command string passes" 'RAD_COMMANDS=deploy .radius/app.bicep'
expect_pass "one array with surrounding whitespace passes" $'RAD_COMMANDS= ["app list"]\n'
expect_pass "deploy params object passes" $'RADIUS_DEPLOY_PARAMS= {"password": "s3cret"}\n'
expect_pass "unset deploy params pass" RADIUS_DEPLOY_PARAMS=
expect_pass "100-character cluster name passes" "AWS_EKS_CLUSTER_NAME=a$(printf 'b%.0s' {1..99})"

expect_code "deploy without cluster or subnets" INPUT_INVALID 2 AWS_EKS_CLUSTER_NAME= RADIUS_SUBNET_IDS=
expect_code "deploy requires the role ARN" INPUT_INVALID 1 AWS_ROLE_ARN=
expect_code "delete requires the role, account, region, and cluster" INPUT_INVALID 4 "${delete[@]}" \
  AWS_ROLE_ARN= AWS_ACCOUNT_ID= AWS_REGION= AWS_EKS_CLUSTER_NAME=
expect_code "delete requires the cluster" INPUT_INVALID 1 "${delete[@]}" AWS_EKS_CLUSTER_NAME=
expect_code "delete checks subnets that are set" INPUT_INVALID 1 "${delete[@]}" RADIUS_SUBNET_IDS=sg-0abc
expect_code "malformed role ARN on delete" INPUT_INVALID 1 "${delete[@]}" AWS_ROLE_ARN=role/x
expect_code "malformed role ARN" INPUT_INVALID 1 AWS_ROLE_ARN=arn:aws:iam::123:role/x
expect_code "malformed account" INPUT_INVALID 1 AWS_ACCOUNT_ID=12345
expect_code "malformed region" INPUT_INVALID 1 AWS_REGION=us-east
expect_code "malformed cluster on delete" INPUT_INVALID 1 "${delete[@]}" 'AWS_EKS_CLUSTER_NAME=bad name'
expect_code "cluster name over 100 characters" INPUT_INVALID 1 "AWS_EKS_CLUSTER_NAME=a$(printf 'b%.0s' {1..100})"
expect_code "malformed subnets" INPUT_INVALID 1 RADIUS_SUBNET_IDS=subnet-0abc,sg-0def
expect_code "pack URL from another commit" INPUT_INVALID 1 RECIPE_PACK_URL=https://example.com/main/pack.bicep
expect_code "short pack commit" INPUT_INVALID 1 RECIPE_PACK_REF=0123456
expect_code "disallowed command in an array" INPUT_COMMAND_NOT_ALLOWED 1 'RAD_COMMANDS=["app list", "install kubernetes --set token=s3cret"]'
expect_code "disallowed single command" INPUT_COMMAND_NOT_ALLOWED 1 'RAD_COMMANDS=workspace switch prod'
for commands in '[] []' '["app list"] ["deploy .radius/app.bicep"]'; do
  expect_code "rad command stream ${commands@Q} rejected" INPUT_COMMAND_NOT_ALLOWED 1 "RAD_COMMANDS=$commands"
done
expect_code "missing app file" INPUT_APP_FILE_MISSING 1 APP_FILE=.radius/missing.bicep
for params in '["s3cret-value"]' '"s3cret-value"' 42 null '  ' $'\n' '{"password": "s3cret"' \
  '{} {}' '[] {}' '{"a": "s3cret"} {"b": 1}'; do
  expect_code "deploy params ${params@Q} rejected" INPUT_DEPLOY_PARAMS_INVALID 1 "RADIUS_DEPLOY_PARAMS=$params"
done
expect_code "all problems in one run" INPUT_INVALID 3 AWS_ACCOUNT_ID= AWS_REGION=x RADIUS_SUBNET_IDS=

for params in 'not json s3cret' '{"a": "s3cret"} {"b": 1}' '{"password": "s3cret"'; do
  run 'RAD_COMMANDS=["install kubernetes --set token=s3cret"]' "RADIUS_DEPLOY_PARAMS=$params"
  if grep -q s3cret <<<"$out"; then bad "secrets are not printed for ${params@Q}"; printf '%s\n' "$out"; else ok "secrets are not printed for ${params@Q}"; fi
done

run AWS_REGION=x
if grep -q 'Fix: Correct AWS_REGION ' <<<"$out" && [[ $(grep -o 'an AWS Region such as' <<<"$out" | wc -l) -eq 1 ]]; then
  ok "message has a fix and names the format once"
else
  bad "message has a fix and names the format once"; printf '%s\n' "$out"
fi

run $'AWS_REGION=x\n::warning::injected'
if grep -q '^::warning' <<<"$out"; then bad "input cannot start a workflow command"; printf '%s\n' "$out"; else ok "input cannot start a workflow command"; fi

echo "$pass passed, $fail failed"
((fail == 0))
