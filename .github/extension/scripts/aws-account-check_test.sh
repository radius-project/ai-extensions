#!/bin/bash

# Tests the "Check the deploy role's AWS account" step in every AWS workflow by
# extracting its real run block and executing it under `bash -e`, the shell
# GitHub uses for a step without `shell:`, with a fake aws CLI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly EXTENSION_DIR="${SCRIPT_DIR}/.."
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

# Writes the step's run block to $3 after checking where the step sits and how
# it receives its inputs.
extract_step() {
    python3 - "$1" "$2" "$3" "${STEP}" <<'PYTHON'
import re
import sys

workflow_file, previous, out_file, step = sys.argv[1:5]
lines = open(workflow_file, encoding="utf-8").read().splitlines()
step_re = re.compile(r"^(\s*)-\s+name:\s+(.+?)\s*$")

steps = [(i, m.group(2)) for i, line in enumerate(lines) if (m := step_re.match(line))]
names = [name for _, name in steps]
if names.count(step) != 1:
    sys.exit("expected one '%s' step, found %d" % (step, names.count(step)))
at = names.index(step)
if at == 0 or names[at - 1] != previous:
    sys.exit("'%s' must directly follow '%s', but follows %r" % (step, previous, names[at - 1] if at else None))

start = steps[at][0]
step_indent = len(lines[start]) - len(lines[start].lstrip(" "))
end = steps[at + 1][0] if at + 1 < len(steps) else len(lines)
fields, run_at, env = {}, None, {}
in_env = False
for i in range(start + 1, end):
    line = lines[i]
    if not line.strip() or line.strip().startswith("#"):
        continue
    indent = len(line) - len(line.lstrip(" "))
    if indent <= step_indent:
        break
    key = re.match(r"^\s*([A-Za-z_-]+):\s*(.*?)\s*$", line)
    if indent == step_indent + 2 and key:
        in_env = key.group(1) == "env"
        fields[key.group(1)] = key.group(2)
        if key.group(1) == "run":
            run_at = i
            break
    elif in_env and key:
        env[key.group(1)] = key.group(2)

if fields.get("if") != "${{ vars.AWS_ROLE_ARN != '' }}":
    sys.exit("the check must run whenever the role signs in, got if=%r" % fields.get("if"))
if "shell" in fields:
    sys.exit("the check must use GitHub's default bash -e shell, got shell=%r" % fields["shell"])
if env != {"ENVIRONMENT_ACCOUNT_ID": "${{ vars.AWS_ACCOUNT_ID }}"}:
    sys.exit("AWS_ACCOUNT_ID must arrive through env, got %r" % env)
if run_at is None or fields.get("run") != "|":
    sys.exit("the check has no 'run: |' block")

body, base = [], None
for line in lines[run_at + 1:end]:
    if not line.strip():
        body.append("")
        continue
    indent = len(line) - len(line.lstrip(" "))
    if base is None:
        base = indent
    if indent < base:
        break
    body.append(line[base:])
while body and not body[-1]:
    body.pop()
if any("${{" in line for line in body):
    sys.exit("the run block must not interpolate expressions")
open(out_file, "w", encoding="utf-8").write("\n".join(body) + "\n")
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

# Runs a step body with the given ENVIRONMENT_ACCOUNT_ID, STS_MODE, and
# STS_ACCOUNT, and records its exit status in STATUS.
run_step() {
    local body="$1" env_account="$2" sts_mode="$3" sts_account="${4:-}"
    : >"${CALLS}"
    STATUS=0
    env \
        PATH="${STUB_BIN}:${PATH}" \
        CALLS="${CALLS}" \
        ENVIRONMENT_ACCOUNT_ID="${env_account}" \
        STS_MODE="${sts_mode}" \
        STS_ACCOUNT="${sts_account}" \
        bash -e "${body}" >"${OUTPUT}" 2>&1 || STATUS=$?
}

expect_failure() {
    local name="$1" message="$2"
    if [ "${STATUS}" -eq 0 ]; then
        fail "${name}: the step should fail"
    fi
    grep -qF "::error::${message}" "${OUTPUT}" || fail "${name}: expected the error: ${message}"
    if grep -qF "matching AWS_ACCOUNT_ID" "${OUTPUT}"; then
        fail "${name}: the step reported a match"
    fi
}

test_passes_when_the_accounts_match() {
    local wf="$1" body="$2"
    run_step "${body}" "${ENV_ACCOUNT}" account "${ENV_ACCOUNT}"
    [ "${STATUS}" -eq 0 ] || fail "${wf}: matching accounts should pass"
    grep -qxF "aws sts get-caller-identity --query Account --output text" "${CALLS}" ||
        fail "${wf}: the step did not ask STS for the role's account"
    grep -qxF "AWS_ROLE_ARN is in AWS account ${ENV_ACCOUNT}, matching AWS_ACCOUNT_ID." "${OUTPUT}" ||
        fail "${wf}: the step did not report the match"
    if grep -qF "::error::" "${OUTPUT}"; then
        fail "${wf}: matching accounts reported an error"
    fi
}

test_fails_when_the_accounts_differ() {
    local wf="$1" body="$2"
    run_step "${body}" "${ENV_ACCOUNT}" account "${OTHER_ACCOUNT}"
    expect_failure "${wf}: mismatch" "AWS_ROLE_ARN is in AWS account ${OTHER_ACCOUNT}, but AWS_ACCOUNT_ID is ${ENV_ACCOUNT}. Fix AWS_ROLE_ARN or AWS_ACCOUNT_ID in this GitHub environment's variables so both name the same account."
}

# Under bash -e without pipefail, a pipe or `|| true` after the call would hide
# its failure. The step must stop at the call with the call's own status.
test_fails_when_get_caller_identity_fails() {
    local wf="$1" body="$2"
    run_step "${body}" "${ENV_ACCOUNT}" fail
    [ "${STATUS}" -eq 255 ] ||
        fail "${wf}: a failed get-caller-identity should stop the step with its status 255, got ${STATUS}"
    grep -qF "ExpiredToken" "${OUTPUT}" || fail "${wf}: the aws error was not shown"
    if grep -qF "::error::" "${OUTPUT}"; then
        fail "${wf}: the step went on after get-caller-identity failed"
    fi
}

test_fails_when_get_caller_identity_returns_no_account() {
    local wf="$1" body="$2" mode
    for mode in empty none; do
        run_step "${body}" "${ENV_ACCOUNT}" "${mode}"
        expect_failure "${wf}: ${mode} STS result" "aws sts get-caller-identity returned no account for AWS_ROLE_ARN."
    done
}

# An empty AWS_ACCOUNT_ID must not pass against an empty STS result, and an
# unchecked value must never reach a workflow command.
test_fails_when_aws_account_id_is_not_an_account() {
    local wf="$1" body="$2" value sts_mode label
    local values=("" "11112222333" "1111222233334" "11112222333a" $'111122223333\n::warning::injected')
    for value in "${values[@]}"; do
        for sts_mode in account empty; do
            run_step "${body}" "${value}" "${sts_mode}" "${value}"
            label="$(printf '%q' "${value}")"
            expect_failure "${wf}: AWS_ACCOUNT_ID=${label} with ${sts_mode} STS" "AWS_ACCOUNT_ID is not a 12-digit AWS account ID. Set it in this GitHub environment's variables to the account of AWS_ROLE_ARN."
            if [ -s "${CALLS}" ]; then
                fail "${wf}: AWS_ACCOUNT_ID=${label} reached aws"
            fi
            if grep -qF "::warning::injected" "${OUTPUT}"; then
                fail "${wf}: AWS_ACCOUNT_ID was written into the step log"
            fi
        done
    done
}

write_stubs
first_body=""
for entry in "${WORKFLOWS[@]}"; do
    wf="${entry%%:*}"
    previous="${entry#*:}"
    body="${TEST_ROOT}/${wf%.yml}.sh"
    extract_step "${EXTENSION_DIR}/${wf}" "${previous}" "${body}" || fail "${wf}: could not extract the check"
    if [ -z "${first_body}" ]; then
        first_body="${body}"
    elif ! cmp -s "${first_body}" "${body}"; then
        fail "${wf}: the check differs from the one in ${WORKFLOWS[0]%%:*}"
    fi
    test_passes_when_the_accounts_match "${wf}" "${body}"
    test_fails_when_the_accounts_differ "${wf}" "${body}"
    test_fails_when_get_caller_identity_fails "${wf}" "${body}"
    test_fails_when_get_caller_identity_returns_no_account "${wf}" "${body}"
    test_fails_when_aws_account_id_is_not_an_account "${wf}" "${body}"
done

COMPLETED=true
echo "AWS account check tests passed"
