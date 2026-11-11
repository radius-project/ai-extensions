#!/bin/bash

# Tests aws-account-check.sh with a fake aws CLI, and checks that every AWS
# workflow runs it through this action in the same place.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly EXTENSION_DIR="${SCRIPT_DIR}/../.."
readonly CHECK="${SCRIPT_DIR}/aws-account-check.sh"
readonly STEP="Check the deploy role's AWS account"
readonly ENV_ACCOUNT=111122223333
readonly OTHER_ACCOUNT=444455556666

# Each workflow and the step its check must directly follow. The deploy and
# delete workflows check right after signing in, before any Radius or AWS
# change. verify-aws.yml checks after its own get-caller-identity step, so an
# STS outage still fails that step and keeps its verify classification.
readonly WORKFLOWS=(
    "run-rad-commands-aws.yml:Configure AWS Credentials (OIDC)"
    "delete-aws.yml:Configure AWS Credentials (OIDC)"
    "delete-environment-aws.yml:Configure AWS Credentials (OIDC)"
    "verify-aws.yml:Verify AWS Credentials"
)

TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
COMPLETED=false
# Bash 3.2 runs an EXIT trap with status 0 after a fatal expansion error, so
# only a run that reached the end may exit 0.
cleanup() {
    rm -rf "${TEST_ROOT}"
    if [ "${COMPLETED}" != true ]; then
        exit 1
    fi
}
trap cleanup EXIT

readonly STUB_BIN="${TEST_ROOT}/bin"
readonly CALLS="${TEST_ROOT}/calls.log"
readonly OUTPUT="${TEST_ROOT}/output.log"

fail() {
    echo "FAIL: $*" >&2
    if [ -f "${OUTPUT}" ]; then
        cat "${OUTPUT}" >&2
    fi
    exit 1
}

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 is required to parse the AWS workflows"
fi

# Checks where the step sits in the workflow and how it calls this action.
check_step() {
    python3 - "$1" "$2" "${STEP}" <<'PYTHON'
import re
import sys

workflow_file, previous, step = sys.argv[1:4]
lines = open(workflow_file, encoding="utf-8").read().splitlines()
step_re = re.compile(r"^(\s*)-\s+name:\s+(.+?)\s*$")

steps = [(i, m.group(2)) for i, line in enumerate(lines) if (m := step_re.match(line))]
names = [name for _, name in steps]
if names.count(step) != 1:
    sys.exit("expected one '%s' step, found %d" % (step, names.count(step)))
at = names.index(step)
if at == 0 or names[at - 1] != previous:
    sys.exit("'%s' must directly follow '%s', but follows %r" % (step, previous, names[at - 1] if at else None))

def parse(at):
    start = steps[at][0]
    step_indent = len(lines[start]) - len(lines[start].lstrip(" "))
    end = steps[at + 1][0] if at + 1 < len(steps) else len(lines)
    fields, inputs, in_with = {}, {}, False
    for i in range(start + 1, end):
        line = lines[i]
        if not line.strip() or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent <= step_indent:
            break
        key = re.match(r"^\s*([A-Za-z_-]+):\s*(.*?)\s*$", line)
        if indent == step_indent + 2 and key:
            in_with = key.group(1) == "with"
            fields[key.group(1)] = key.group(2)
        elif in_with and key:
            inputs[key.group(1)] = key.group(2)
    return fields, inputs

fields, inputs = parse(at)
if fields.get("if") != parse(at - 1)[0].get("if"):
    sys.exit("the check must run whenever the role signs in, got if=%r" % fields.get("if"))
if fields.get("uses") != "radius-project/ai-extensions/.github/extension/actions/aws-account-check@{{RADIUS_REF}}":
    sys.exit("the step must use the aws-account-check action, got uses=%r" % fields.get("uses"))
if inputs != {"account-id": "${{ vars.AWS_ACCOUNT_ID }}"}:
    sys.exit("AWS_ACCOUNT_ID must arrive as the account-id input, got %r" % inputs)
if "run" in fields or "env" in fields:
    sys.exit("the step must not add a run block or env")
PYTHON
}

# The fake aws answers get-caller-identity as STS_MODE says: the account in
# STS_ACCOUNT, an empty or "None" result, or a failed call.
write_stubs() {
    mkdir -p "${STUB_BIN}"
    cat >"${STUB_BIN}/aws" <<'STUB'
#!/bin/bash
echo "aws $*" >>"${CALLS}"
case "${STS_MODE}" in
    account) echo "${STS_ACCOUNT}" ;;
    empty) ;;
    none) echo "None" ;;
    fail)
        echo "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation" >&2
        exit 255
        ;;
    *) echo "unexpected STS_MODE ${STS_MODE}" >&2; exit 99 ;;
esac
STUB
    chmod +x "${STUB_BIN}/aws"
}

STATUS=0

# Runs the check with the given ENVIRONMENT_ACCOUNT_ID, STS_MODE, and
# STS_ACCOUNT, and records its exit status in STATUS.
run_step() {
    local env_account="$1" sts_mode="$2" sts_account="${3:-}"
    : >"${CALLS}"
    STATUS=0
    env \
        PATH="${STUB_BIN}:${PATH}" \
        CALLS="${CALLS}" \
        ENVIRONMENT_ACCOUNT_ID="${env_account}" \
        STS_MODE="${sts_mode}" \
        STS_ACCOUNT="${sts_account}" \
        bash "${CHECK}" >"${OUTPUT}" 2>&1 || STATUS=$?
}

# Each error is one titled annotation that starts with its catalog code.
expect_failure() {
    local name="$1" code="$2" message="$3"
    if [ "${STATUS}" -eq 0 ]; then
        fail "${name}: the step should fail"
    fi
    grep -E "^::error title=[^:]+::" "${OUTPUT}" | grep -qF "::[${code}] ${message}" ||
        fail "${name}: expected the error: [${code}] ${message}"
    [ "$(grep -c '^::error' "${OUTPUT}")" -eq 1 ] || fail "${name}: expected exactly one error annotation"
    if grep -qF "matching AWS_ACCOUNT_ID" "${OUTPUT}"; then
        fail "${name}: the step reported a match"
    fi
}

test_passes_when_the_accounts_match() {
    run_step "${ENV_ACCOUNT}" account "${ENV_ACCOUNT}"
    [ "${STATUS}" -eq 0 ] || fail "matching accounts should pass"
    grep -qxF "aws sts get-caller-identity --cli-connect-timeout 5 --cli-read-timeout 10 --query Account --output text" "${CALLS}" ||
        fail "the step did not ask STS for the role's account"
    grep -qxF "AWS_ROLE_ARN is in AWS account ${ENV_ACCOUNT}, matching AWS_ACCOUNT_ID." "${OUTPUT}" ||
        fail "the step did not report the match"
    if grep -qF "::error" "${OUTPUT}"; then
        fail "matching accounts reported an error"
    fi
}

test_fails_when_the_accounts_differ() {
    run_step "${ENV_ACCOUNT}" account "${OTHER_ACCOUNT}"
    expect_failure "mismatch" AWS_ACCOUNT_MISMATCH "AWS_ROLE_ARN is in AWS account ${OTHER_ACCOUNT}, but AWS_ACCOUNT_ID is ${ENV_ACCOUNT}. Fix: Change AWS_ROLE_ARN or AWS_ACCOUNT_ID in this GitHub environment's variables so both name the same account."
}

# The step must stop at the failed call, after the aws error, with a coded
# error instead of a bare exit status.
test_fails_when_get_caller_identity_fails() {
    run_step "${ENV_ACCOUNT}" fail
    expect_failure "failed STS call" AWS_IDENTITY_UNAVAILABLE "aws sts get-caller-identity failed for AWS_ROLE_ARN. Fix: Read the AWS error above, then rerun the workflow."
    grep -qF "ExpiredToken" "${OUTPUT}" || fail "the aws error was not shown"
}

test_fails_when_get_caller_identity_returns_no_account() {
    local mode
    for mode in empty none; do
        run_step "${ENV_ACCOUNT}" "${mode}"
        expect_failure "${mode} STS result" AWS_IDENTITY_UNAVAILABLE "aws sts get-caller-identity returned no account for AWS_ROLE_ARN."
    done
}

# An empty AWS_ACCOUNT_ID must not pass against an empty STS result, and a
# value must never start a workflow command.
test_fails_when_aws_account_id_is_not_the_account() {
    local value label
    local values=("" "11112222333" $'111122223333\n::warning::injected')
    for value in "${values[@]}"; do
        label="$(printf '%q' "${value}")"
        run_step "${value}" account "${ENV_ACCOUNT}"
        expect_failure "AWS_ACCOUNT_ID=${label}" AWS_ACCOUNT_MISMATCH "AWS_ROLE_ARN is in AWS account ${ENV_ACCOUNT}, but AWS_ACCOUNT_ID is "
        run_step "${value}" empty
        expect_failure "AWS_ACCOUNT_ID=${label} with an empty STS result" AWS_IDENTITY_UNAVAILABLE "aws sts get-caller-identity returned no account for AWS_ROLE_ARN."
        if grep -q '^::warning' "${OUTPUT}"; then
            fail "AWS_ACCOUNT_ID=${label} started a workflow command"
        fi
    done
}

# The action passes the account through env and runs the script from a
# one-line `run:`, so GitHub prints none of the script's messages.
# shellcheck disable=SC2016  # matching literal action text
grep -qxF '        ENVIRONMENT_ACCOUNT_ID: ${{ inputs.account-id }}' "${SCRIPT_DIR}/action.yml" ||
    fail "action.yml must pass account-id to the script as ENVIRONMENT_ACCOUNT_ID"
# shellcheck disable=SC2016
grep -qxF '      run: bash "$GITHUB_ACTION_PATH/aws-account-check.sh"' "${SCRIPT_DIR}/action.yml" ||
    fail "action.yml must run the script from a one-line run"

for entry in "${WORKFLOWS[@]}"; do
    wf="${entry%%:*}"
    check_step "${EXTENSION_DIR}/${wf}" "${entry#*:}" || fail "${wf}: the check is not wired as expected"
done

write_stubs
test_passes_when_the_accounts_match
test_fails_when_the_accounts_differ
test_fails_when_get_caller_identity_fails
test_fails_when_get_caller_identity_returns_no_account
test_fails_when_aws_account_id_is_not_the_account

COMPLETED=true
echo "AWS account check tests passed"
