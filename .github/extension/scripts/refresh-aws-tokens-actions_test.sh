#!/bin/bash

# Tests how the run-rad-commands and delete-resource actions run the AWS token
# refresher, by executing each action's real step script with a fake refresher
# and a fake rad. Each action must refresh before running rad, fail closed when
# that refresh fails, and stop its background watcher when the step exits.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly ACTIONS_DIR="${SCRIPT_DIR}/../actions"
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'if [[ -s "${WATCH_PID_FILE:-}" ]]; then kill "$(cat "${WATCH_PID_FILE}")" 2>/dev/null || true; fi; rm -rf "${TEST_ROOT}"' EXIT

readonly EXT="${TEST_ROOT}/extension"
readonly OUTPUT_DIR="${TEST_ROOT}/output"
readonly CALLS="${TEST_ROOT}/calls"
readonly WATCH_PID_FILE="${TEST_ROOT}/watch-pid"
readonly STEP_LOG="${TEST_ROOT}/step.log"

fail() {
    echo "FAIL: $*" >&2
    if [[ -f "${STEP_LOG}" ]]; then
        cat "${STEP_LOG}" >&2
    fi
    exit 1
}

for tool in python3 jq; do
    command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required"
done

# Writes an action step's run script, sending its result artifact to
# OUTPUT_DIR instead of the runner's /tmp/radius-output.
extract_step() {
    local action="$1"
    local step="$2"

    mkdir -p "${EXT}/actions/${action}"
    python3 - "${ACTIONS_DIR}/${action}/action.yml" "${step}" \
        "${EXT}/actions/${action}/step.sh" <<'PYTHON'
import re
import sys

action_file, step, out_file = sys.argv[1:4]
lines = open(action_file, encoding="utf-8").read().splitlines()
names = [
    i for i, line in enumerate(lines)
    if re.match(r"^\s*-\s+name:\s+" + re.escape(step) + r"\s*$", line)
]
if len(names) != 1:
    sys.exit("expected one '%s' step, found %d" % (step, len(names)))
step_indent = len(lines[names[0]]) - len(lines[names[0]].lstrip(" "))
run_at = None
for i in range(names[0] + 1, len(lines)):
    line = lines[i]
    indent = len(line) - len(line.lstrip(" "))
    if line.strip() and indent <= step_indent:
        break
    if line.strip() == "run: |":
        run_at = i
        break
if run_at is None:
    sys.exit("no run block in step '%s'" % step)
run_indent = len(lines[run_at]) - len(lines[run_at].lstrip(" "))
body = []
for line in lines[run_at + 1:]:
    indent = len(line) - len(line.lstrip(" "))
    if line.strip() and indent <= run_indent:
        break
    body.append(line[run_indent + 2:])
open(out_file, "w", encoding="utf-8").write("\n".join(body) + "\n")
PYTHON
    sed -i.bak "s|/tmp/radius-output|${OUTPUT_DIR}|g" "${EXT}/actions/${action}/step.sh"
    rm -f "${EXT}/actions/${action}/step.sh.bak"
    if grep -q '/tmp/radius-output' "${EXT}/actions/${action}/step.sh"; then
        fail "the ${action} step still writes to /tmp/radius-output"
    fi
}

extract_step run-rad-commands "Run rad commands"
extract_step delete-resource "Delete Radius resource"
mkdir -p "${EXT}/actions/deploy-progress" "${EXT}/scripts" "${TEST_ROOT}/bin"
cp "${ACTIONS_DIR}/deploy-progress/progress.sh" "${EXT}/actions/deploy-progress/"
cp "${ACTIONS_DIR}/run-rad-commands/allowed-commands.sh" "${EXT}/actions/run-rad-commands/"
# The fake parameter loader records the app file it reads, so the default
# deploy's calls show whether it stopped at the refresh. With WAIT_FOR_WATCHER
# set, it first waits for the watcher, so the order of the calls is fixed.
cat >"${EXT}/actions/run-rad-commands/deploy-parameters.sh" <<'EOF'
load_declared_app_params() {
    if [[ -n "${WAIT_FOR_WATCHER:-}" ]]; then
        for _ in $(seq 1 100); do
            [[ -s "${WATCH_PID_FILE}" ]] && break
            /bin/sleep 0.05
        done
    fi
    printf 'load parameters %s\n' "$1" >>"${CALLS}"
}
append_generated_app_params() { GENERATED_APP_PARAMS=(); }
EOF

# The fake refresher records each call with the AWS settings it received.
# PREPARE_STATUS sets the --prepare exit status. --watch records its process
# and stays running until the action stops it.
cat >"${EXT}/scripts/refresh-aws-tokens.sh" <<'EOF'
#!/bin/bash
printf 'refresher %s role=%s cluster=%s region=%s\n' "$1" "${RADIUS_AWS_ROLE_ARN}" \
    "${RADIUS_AWS_EKS_CLUSTER_NAME}" "${RADIUS_AWS_REGION}" >>"${CALLS}"
case "$1" in
    --prepare) exit "${PREPARE_STATUS:-0}" ;;
    --watch)
        printf '%s' "$$" >"${WATCH_PID_FILE}"
        exec /bin/sleep 300
        ;;
esac
exit 2
EOF

# RAD_STATUS sets the exit status of every rad call. With WAIT_FOR_WATCHER set,
# rad first waits for the background watcher and records that it is running,
# which proves the watcher covers the command.
cat >"${TEST_ROOT}/bin/rad" <<'EOF'
#!/bin/bash
if [[ -n "${WAIT_FOR_WATCHER:-}" ]]; then
    for _ in $(seq 1 100); do
        [[ -s "${WATCH_PID_FILE}" ]] && break
        /bin/sleep 0.05
    done
    if [[ -s "${WATCH_PID_FILE}" ]] && kill -0 "$(cat "${WATCH_PID_FILE}")" 2>/dev/null; then
        printf 'watcher running\n' >>"${CALLS}"
    fi
fi
printf 'rad %s\n' "$*" >>"${CALLS}"
exit "${RAD_STATUS:-0}"
EOF
chmod +x "${EXT}/scripts/refresh-aws-tokens.sh" "${TEST_ROOT}/bin/rad"

export CALLS WATCH_PID_FILE
export PATH="${TEST_ROOT}/bin:${PATH}"
export REFRESH_AZURE_OIDC_TOKEN=false
export RADIUS_AWS_EKS_CLUSTER_NAME="demo-cluster"
export RADIUS_AWS_REGION="us-west-2"
readonly ROLE="arn:aws:iam::111122223333:role/radius-deploy"
readonly REFRESHER_ARGS="role=${ROLE} cluster=demo-cluster region=us-west-2"

# Runs an action step as GitHub runs a bash step and prints its exit status, or
# 124 when the step has not exited after 15 seconds, so a step that waits on a
# watcher it never stopped fails instead of hanging the suite.
run_step() {
    local action="$1"
    local status=0
    local pid

    rm -rf "${CALLS}" "${WATCH_PID_FILE}" "${OUTPUT_DIR}"
    : >"${CALLS}"
    rm -rf "${TEST_ROOT}/runner"
    mkdir -p "${TEST_ROOT}/runner"
    GITHUB_ACTION_PATH="${EXT}/actions/${action}" RUNNER_TEMP="${TEST_ROOT}/runner" \
        bash --noprofile --norc -eo pipefail "${EXT}/actions/${action}/step.sh" \
        >"${STEP_LOG}" 2>&1 &
    pid=$!
    for _ in $(seq 1 300); do
        kill -0 "${pid}" 2>/dev/null || break
        /bin/sleep 0.05
    done
    if kill -0 "${pid}" 2>/dev/null; then
        kill -KILL "${pid}" 2>/dev/null || true
        if [[ -s "${WATCH_PID_FILE}" ]]; then
            kill "$(cat "${WATCH_PID_FILE}")" 2>/dev/null || true
        fi
        wait "${pid}" 2>/dev/null || true
        printf '124'
        return
    fi
    wait "${pid}" || status=$?
    printf '%s' "${status}"
}

expect_calls() {
    local expected="$1"
    local context="$2"

    [[ "$(cat "${CALLS}")" == "${expected}" ]] ||
        fail "${context}: expected calls:
${expected}
got:
$(cat "${CALLS}")"
}

expect_watcher_stopped() {
    local context="$1"
    local pid

    [[ -s "${WATCH_PID_FILE}" ]] || fail "${context}: expected the watcher to start"
    pid="$(cat "${WATCH_PID_FILE}")"
    if kill -0 "${pid}" 2>/dev/null; then
        kill "${pid}" 2>/dev/null || true
        fail "${context}: expected the step to stop its watcher when it exits"
    fi
}

expect_result() {
    local file="$1"
    local outcome="$2"
    local exit_code="$3"
    local context="$4"

    [[ "$(jq -r '.outcome' "${OUTPUT_DIR}/${file}")" == "${outcome}" &&
        "$(jq -r '.exitCode' "${OUTPUT_DIR}/${file}")" == "${exit_code}" ]] ||
        fail "${context}: expected ${outcome}/${exit_code} in ${file}, got $(cat "${OUTPUT_DIR}/${file}")"
}

# run-rad-commands with caller-supplied commands.
export ENVIRONMENT="dev" APP_FILE=".radius/app.bicep" APP_IMAGE="image"
export REGISTRY_USERNAME="" REGISTRY_PASSWORD="" RADIUS_DEPLOY_PARAMS=""
export RAD_COMMANDS='["env list"]'
readonly COMMANDS_RESULT="rad-commands-result.json"

# Azure passes no AWS inputs, so no AWS refresh runs.
status="$(RADIUS_AWS_ROLE_ARN="" RADIUS_AWS_EKS_CLUSTER_NAME="" RADIUS_AWS_REGION="" run_step run-rad-commands)"
[[ "${status}" == "0" ]] || fail "commands without AWS inputs: expected success, got ${status}"
expect_calls "rad env list" "commands without AWS inputs"
expect_result "${COMMANDS_RESULT}" succeeded 0 "commands without AWS inputs"

# An AWS caller whose role is empty still runs the refresher, which rejects the
# missing role, so the commands do not run without target credentials.
status="$(RADIUS_AWS_ROLE_ARN="" PREPARE_STATUS=1 run_step run-rad-commands)"
[[ "${status}" == "1" ]] || fail "commands without a deploy role: expected exit 1, got ${status}"
expect_calls "refresher --prepare role= cluster=demo-cluster region=us-west-2" "commands without a deploy role"
expect_result "${COMMANDS_RESULT}" command_failed 1 "commands without a deploy role"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" WAIT_FOR_WATCHER=1 run_step run-rad-commands)"
[[ "${status}" == "0" ]] || fail "commands with a deploy role: expected success, got ${status}"
expect_calls "refresher --prepare ${REFRESHER_ARGS}
refresher --watch ${REFRESHER_ARGS}
watcher running
rad env list" "commands with a deploy role"
expect_watcher_stopped "commands with a deploy role"
expect_result "${COMMANDS_RESULT}" succeeded 0 "commands with a deploy role"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" WAIT_FOR_WATCHER=1 RAD_STATUS=1 run_step run-rad-commands)"
[[ "${status}" == "1" ]] || fail "a failed command: expected exit 1, got ${status}"
expect_watcher_stopped "a failed command"
expect_result "${COMMANDS_RESULT}" command_failed 1 "a failed command"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" PREPARE_STATUS=1 run_step run-rad-commands)"
[[ "${status}" == "1" ]] || fail "a failed token refresh before commands: expected exit 1, got ${status}"
expect_calls "refresher --prepare ${REFRESHER_ARGS}" "a failed token refresh before commands"
[[ ! -f "${WATCH_PID_FILE}" ]] || fail "a failed token refresh before commands: expected no watcher"
expect_result "${COMMANDS_RESULT}" command_failed 1 "a failed token refresh before commands"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" RAD_COMMANDS='["kubectl get pods"]' run_step run-rad-commands)"
[[ "${status}" == "2" ]] || fail "a disallowed command: expected exit 2, got ${status}"
expect_calls "" "a disallowed command"
expect_result "${COMMANDS_RESULT}" disallowed_command 2 "a disallowed command"

# The default deploy refreshes before it reads the app's parameters, keeps the
# watcher running through `rad deploy`, and stops it on exit.
status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" WAIT_FOR_WATCHER=1 RAD_COMMANDS="" run_step run-rad-commands)"
[[ "${status}" == "0" ]] || fail "the default deploy: expected success, got ${status}"
expect_calls "refresher --prepare ${REFRESHER_ARGS}
refresher --watch ${REFRESHER_ARGS}
load parameters .radius/app.bicep
watcher running
rad deploy .radius/app.bicep --environment dev" "the default deploy"
expect_watcher_stopped "the default deploy"
expect_result "${COMMANDS_RESULT}" succeeded 0 "the default deploy"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" WAIT_FOR_WATCHER=1 RAD_STATUS=1 RAD_COMMANDS="" run_step run-rad-commands)"
[[ "${status}" == "1" ]] || fail "a failed default deploy: expected exit 1, got ${status}"
expect_watcher_stopped "a failed default deploy"
expect_result "${COMMANDS_RESULT}" command_failed 1 "a failed default deploy"

status="$(RADIUS_AWS_ROLE_ARN="" RADIUS_AWS_EKS_CLUSTER_NAME="" RADIUS_AWS_REGION="" RAD_COMMANDS="" run_step run-rad-commands)"
[[ "${status}" == "0" ]] || fail "the default deploy without AWS inputs: expected success, got ${status}"
expect_calls "load parameters .radius/app.bicep
rad deploy .radius/app.bicep --environment dev" "the default deploy without AWS inputs"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" PREPARE_STATUS=1 RAD_COMMANDS="" run_step run-rad-commands)"
[[ "${status}" == "1" ]] || fail "a failed token refresh before the default deploy: expected exit 1, got ${status}"
expect_calls "refresher --prepare ${REFRESHER_ARGS}" "a failed token refresh before the default deploy"
[[ ! -f "${WATCH_PID_FILE}" ]] || fail "a failed token refresh before the default deploy: expected no watcher"
expect_result "${COMMANDS_RESULT}" command_failed 1 "a failed token refresh before the default deploy"

# delete-resource.
export RESOURCE_TYPE="application" RESOURCE_NAME="todo" FORCE_DELETE="false"
readonly DELETE_RESULT="rad-delete-result.json"

status="$(RADIUS_AWS_ROLE_ARN="" RADIUS_AWS_EKS_CLUSTER_NAME="" RADIUS_AWS_REGION="" run_step delete-resource)"
[[ "${status}" == "0" ]] || fail "a delete without AWS inputs: expected success, got ${status}"
expect_calls "rad app delete todo --yes" "a delete without AWS inputs"
expect_result "${DELETE_RESULT}" succeeded 0 "a delete without AWS inputs"

status="$(RADIUS_AWS_ROLE_ARN="" RADIUS_AWS_REGION="" PREPARE_STATUS=1 run_step delete-resource)"
[[ "${status}" == "1" ]] || fail "a delete with only a cluster: expected exit 1, got ${status}"
expect_calls "refresher --prepare role= cluster=demo-cluster region=" "a delete with only a cluster"
expect_result "${DELETE_RESULT}" failed 1 "a delete with only a cluster"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" WAIT_FOR_WATCHER=1 run_step delete-resource)"
[[ "${status}" == "0" ]] || fail "a delete with a deploy role: expected success, got ${status}"
expect_calls "refresher --prepare ${REFRESHER_ARGS}
refresher --watch ${REFRESHER_ARGS}
watcher running
rad app delete todo --yes" "a delete with a deploy role"
expect_watcher_stopped "a delete with a deploy role"
expect_result "${DELETE_RESULT}" succeeded 0 "a delete with a deploy role"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" WAIT_FOR_WATCHER=1 RAD_STATUS=1 run_step delete-resource)"
[[ "${status}" == "1" ]] || fail "a failed delete: expected exit 1, got ${status}"
expect_watcher_stopped "a failed delete"
expect_result "${DELETE_RESULT}" failed 1 "a failed delete"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" PREPARE_STATUS=1 run_step delete-resource)"
[[ "${status}" == "1" ]] || fail "a failed token refresh before a delete: expected exit 1, got ${status}"
expect_calls "refresher --prepare ${REFRESHER_ARGS}" "a failed token refresh before a delete"
[[ ! -f "${WATCH_PID_FILE}" ]] || fail "a failed token refresh before a delete: expected no watcher"
expect_result "${DELETE_RESULT}" failed 1 "a failed token refresh before a delete"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" RESOURCE_TYPE="environment" RESOURCE_NAME="dev" \
    WAIT_FOR_WATCHER=1 run_step delete-resource)"
[[ "${status}" == "0" ]] || fail "an environment delete: expected success, got ${status}"
expect_calls "refresher --prepare ${REFRESHER_ARGS}
refresher --watch ${REFRESHER_ARGS}
watcher running
rad env delete dev --yes" "an environment delete"
expect_watcher_stopped "an environment delete"
expect_result "${DELETE_RESULT}" succeeded 0 "an environment delete"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" RESOURCE_TYPE="environment" RESOURCE_NAME="dev" \
    PREPARE_STATUS=1 run_step delete-resource)"
[[ "${status}" == "1" ]] || fail "a failed token refresh before an environment delete: expected exit 1, got ${status}"
expect_calls "refresher --prepare ${REFRESHER_ARGS}" "a failed token refresh before an environment delete"
[[ ! -f "${WATCH_PID_FILE}" ]] || fail "a failed token refresh before an environment delete: expected no watcher"
expect_result "${DELETE_RESULT}" failed 1 "a failed token refresh before an environment delete"

status="$(RADIUS_AWS_ROLE_ARN="${ROLE}" RESOURCE_TYPE="volume" run_step delete-resource)"
[[ "${status}" == "2" ]] || fail "an unsupported resource type: expected exit 2, got ${status}"
expect_calls "" "an unsupported resource type"
expect_result "${DELETE_RESULT}" invalid_input 2 "an unsupported resource type"

echo "refresh-aws-tokens action tests passed"
