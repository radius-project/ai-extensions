#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "$TEST_ROOT"' EXIT

# shellcheck source=.github/extension/actions/run-rad-commands/deploy-reconnect.sh
source "$SCRIPT_DIR/deploy-reconnect.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

rad() {
    local attempt
    attempt="$(wc -l <"$TEST_ROOT/calls")"
    printf '%q ' "$@" >>"$TEST_ROOT/calls"
    printf '\n' >>"$TEST_ROOT/calls"
    if [[ "$attempt" -lt "$FAILURES" ]]; then
        cat "$TEST_ROOT/error"
        return "$FAILURE_CODE"
    fi
    echo "Deployment complete"
}

sleep() {
    printf '%s\n' "$1" >>"$TEST_ROOT/delays"
    return "$SLEEP_CODE"
}

reset_case() {
    : >"$TEST_ROOT/calls"
    : >"$TEST_ROOT/delays"
    FAILURES=0
    FAILURE_CODE=1
    SLEEP_CODE=0
    jq -n '{
        code:"DeploymentFailed",
        message:"Deployment failed",
        details:[{
            code:"RecipeDeploymentFailed",
            message:"failed to deploy recipe default",
            details:[{
                code:"ResourceDeploymentFailure",
                message:"Unable to read data: Connection reset by peer"
            }]
        }, {code:"OK", message:""}]
    }' >"$TEST_ROOT/json"
    { echo "Deploying application"; printf 'Error: '; cat "$TEST_ROOT/json"; } >"$TEST_ROOT/error"
}

run_case() {
    local expected_code="$1" expected_calls="$2" code=0
    shift 2
    radius_deploy_with_reconnect "$@" >"$TEST_ROOT/output" 2>&1 || code=$?
    [[ "$code" -eq "$expected_code" ]] ||
        fail "expected exit $expected_code, got $code: $(cat "$TEST_ROOT/output")"
    [[ "$(wc -l <"$TEST_ROOT/calls")" -eq "$expected_calls" ]] ||
        fail "expected $expected_calls calls: $(cat "$TEST_ROOT/calls")"
}

reset_case
run_case 0 1 deploy app.bicep
[[ ! -s "$TEST_ROOT/delays" ]] || fail "successful deploy must not wait"

reset_case
FAILURES=2
run_case 0 3 deploy app.bicep --environment dev --parameters 'message=with spaces'
[[ "$(sort -u "$TEST_ROOT/calls" | wc -l)" -eq 1 ]] ||
    fail "every retry must preserve the exact arguments"
[[ "$(cat "$TEST_ROOT/delays")" == $'2\n4' ]] ||
    fail "expected bounded delays of 2 and 4 seconds"
[[ "$(grep -c 'Connection reset by peer' "$TEST_ROOT/output")" -eq 2 ]] ||
    fail "output must retain both failed attempts"
[[ "$(grep -c 'Reconnecting' "$TEST_ROOT/output")" -eq 2 ]] ||
    fail "each reconnect must report a warning"

reset_case
FAILURES=3
FAILURE_CODE=7
run_case 7 3 deploy app.bicep

for message in \
    'Connection reset by peer' \
    'Error: {"code":"DeploymentFailed","details":[]}' \
    'Error: {"code":"DeploymentFailed","details":[{"code":"RecipeDeploymentFailed","message":"Connection reset by peer"}]}' \
    'Error: {"code":"DeploymentFailed","details":[{"code":"RecipeDeploymentFailed","details":[{"code":"ResourceDeploymentFailure","message":"AuthorizationFailed"}]}]}' \
    'Error: {"code":"DeploymentFailed","details":[{"code":"RecipeDeploymentFailed","details":[{"code":"ResourceDeploymentFailure","message":"Connection reset by peer"},{"code":"AuthorizationFailed","message":"Access denied"}]}]}' \
    'Error: {"code":"DeploymentFailed","message":"Connection reset by peer"' \
    'Error: {"code":"OtherFailure","details":[{"code":"RecipeDeploymentFailed","details":[{"code":"ResourceDeploymentFailure","message":"Connection reset by peer"}]}]}'; do
    reset_case
    FAILURES=3
    printf '%s\n' "$message" >"$TEST_ROOT/error"
    run_case 1 1 deploy app.bicep
    [[ ! -s "$TEST_ROOT/delays" ]] || fail "must not wait for a non-retryable error"
done

reset_case
FAILURES=3
run_case 1 1 app delete app

reset_case
FAILURES=3
FAILURE_CODE=143
run_case 143 1 deploy app.bicep

reset_case
FAILURES=3
SLEEP_CODE=130
run_case 130 1 deploy app.bicep

reset_case
tee() {
    cat >/dev/null
    return 9
}
run_case 9 1 deploy app.bicep
unset -f tee
grep -q 'Could not capture' "$TEST_ROOT/output" ||
    fail "an output capture failure must be explicit"

# Check both action paths, not just the helper in isolation.
[[ "$(grep -c 'record .*radius_deploy_with_reconnect' "$SCRIPT_DIR/action.yml")" -eq 1 ]] ||
    fail "custom deploys must use reconnect recovery"
# shellcheck disable=SC2016 # Match the literal workflow variable.
grep -q 'radius_deploy_with_reconnect deploy "$APP_FILE"' "$SCRIPT_DIR/action.yml" ||
    fail "default deploys must use reconnect recovery"

echo "run-rad-commands deploy reconnect tests passed"
