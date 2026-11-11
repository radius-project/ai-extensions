#!/bin/bash

# Tests the two steps that write the EKS kubeconfig in the AWS workflows,
# "Connect to EKS cluster" and "Refresh external deployment target
# credentials", by running each one's real script with fake aws and kubectl.
# In the deploy and both delete workflows, the refresh step must write a
# kubeconfig that carries the EKS token inline and names the pods' token file,
# and store that token under the target-kubeconfig Secret's `token` key, which
# the token refresher keeps current. A step that cannot mint an EKS token must
# fail before it writes the kubeconfig or the Secret. Both
# steps take the cluster endpoint and certificate authority from Preflight EKS
# access, so neither calls describe-cluster.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly WORKFLOW_DIR="${SCRIPT_DIR}/.."
readonly REFRESHER="${SCRIPT_DIR}/refresh-aws-tokens.sh"
readonly CONNECT_STEP="Connect to EKS cluster"
readonly REFRESH_STEP="Refresh external deployment target credentials"
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

readonly STUB_BIN="${TEST_ROOT}/bin"
export CALLS="${TEST_ROOT}/calls"
export APPLIED="${TEST_ROOT}/applied"
readonly STEP_LOG="${TEST_ROOT}/step.log"
readonly KUBECONFIG_PATH="${TEST_ROOT}/workspace/.radius-target-kubeconfig"
readonly ROLE="arn:aws:iam::111122223333:role/radius-deploy"

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

# The refresh step must point tokenFile at the path where the refresher's
# `token` key is mounted in the pods.
POD_TOKEN_FILE="$(sed -n 's/^readonly POD_TOKEN_FILE="\(.*\)"$/\1/p' "${REFRESHER}")"
readonly POD_TOKEN_FILE
[[ "${POD_TOKEN_FILE}" == /etc/radius/target-kubeconfig/token ]] ||
    fail "expected the refresher to write the token mounted at /etc/radius/target-kubeconfig/token, got '${POD_TOKEN_FILE}'"

# Writes a step's script as GitHub runs it: each `${{ vars.NAME }}` replaced by
# the value of the environment variable VARS_NAME, each
# `${{ steps.eks-preflight.outputs.NAME }}` by PREFLIGHT_NAME (upper case, with
# underscores), and the step's `env:` values exported first.
extract_step() {
    local workflow="$1"
    local step="$2"
    local out="$3"

    python3 - "${WORKFLOW_DIR}/${workflow}" "${step}" "${out}" <<'PYTHON'
import os
import re
import shlex
import sys

workflow_file, step, out_file = sys.argv[1:4]
lines = open(workflow_file, encoding="utf-8").read().splitlines()
names = [
    i for i, line in enumerate(lines)
    if re.match(r"^\s*-\s+name:\s+" + re.escape(step) + r"\s*$", line)
]
if len(names) != 1:
    sys.exit("expected one '%s' step, found %d" % (step, len(names)))


def indent_of(line):
    return len(line) - len(line.lstrip(" "))


def substitute(text):
    text = re.sub(
        r"\$\{\{\s*vars\.([A-Z_]+)\s*\}\}",
        lambda match: os.environ.get("VARS_" + match.group(1), ""),
        text,
    )
    return re.sub(
        r"\$\{\{\s*steps\.eks-preflight\.outputs\.([a-z-]+)\s*\}\}",
        lambda match: os.environ.get("PREFLIGHT_" + match.group(1).upper().replace("-", "_"), ""),
        text,
    )


step_indent = indent_of(lines[names[0]])
key_indent = step_indent + 2
exports = []
run_at = None
i = names[0] + 1
while i < len(lines):
    line = lines[i]
    if line.strip() and indent_of(line) <= step_indent:
        break
    if indent_of(line) == key_indent and line.strip() == "env:":
        i += 1
        while i < len(lines) and (not lines[i].strip() or indent_of(lines[i]) > key_indent):
            entry = lines[i].strip()
            if entry and not entry.startswith("#"):
                key, value = entry.split(":", 1)
                exports.append("export %s=%s" % (key, shlex.quote(substitute(value.strip()))))
            i += 1
        continue
    if indent_of(line) == key_indent and line.strip() == "run: |":
        run_at = i
        break
    i += 1
if run_at is None:
    sys.exit("no run block in step '%s'" % step)
body = []
for line in lines[run_at + 1:]:
    if line.strip() and indent_of(line) <= key_indent:
        break
    body.append(line[key_indent + 2:])
script = substitute("\n".join(exports + body) + "\n")
if "${{" in script:
    sys.exit("unsubstituted expression left in step '%s'" % step)
open(out_file, "w", encoding="utf-8").write(script)
PYTHON
}

mkdir -p "${STUB_BIN}"
# GET_TOKEN=fail makes get-token exit nonzero, and GET_TOKEN=empty makes it
# return a credential without a token.
cat >"${STUB_BIN}/aws" <<'EOF'
#!/bin/bash
printf 'aws %s\n' "$*" >>"${CALLS}"
case "$*" in
    "eks get-token "*)
        case "${GET_TOKEN:-}" in
            fail)
                echo "aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials." >&2
                exit 253
                ;;
            empty) echo '{"kind":"ExecCredential","status":{}}' ;;
            *) echo '{"kind":"ExecCredential","status":{"token":"eks-token-1"}}' ;;
        esac
        ;;
    *) exit 1 ;;
esac
EOF

# `create secret` accepts only the target-kubeconfig Secret in radius-system, and
# prints each --from-file key and file content so `apply` can record the data.
cat >"${STUB_BIN}/kubectl" <<'EOF'
#!/bin/bash
case "$1" in
    create)
        printf 'kubectl create secret %s\n' "$4" >>"${CALLS}"
        namespace=""
        previous=""
        for argument in "$@"; do
            [[ "${previous}" == "--namespace" ]] && namespace="${argument}"
            previous="${argument}"
        done
        if [[ "$2 $3 $4" != "secret generic target-kubeconfig" || "${namespace}" != "radius-system" ]]; then
            echo "unexpected Secret: $* " >&2
            exit 1
        fi
        for argument in "$@"; do
            case "${argument}" in
                --from-file=*)
                    key="${argument#--from-file=}"
                    printf '%s<<\n%s\n>>\n' "${key%%=*}" "$(cat "${key#*=}")"
                    ;;
            esac
        done
        ;;
    # `create` and `apply` run at the same time in the step's pipe. Logging after
    # `cat` reaches EOF, which follows `create` exiting, keeps the order fixed.
    apply)
        cat >"${APPLIED}"
        printf 'kubectl %s\n' "$*" >>"${CALLS}"
        ;;
    rollout) printf 'kubectl %s\n' "$*" >>"${CALLS}" ;;
    --kubeconfig)
        [[ "$2" == "${RADIUS_TARGET_KUBECONFIG}" && "$3" == "--request-timeout=10s" && "$4" == "cluster-info" ]] || exit 1
        printf 'kubectl cluster-info with the target kubeconfig\n' >>"${CALLS}"
        if [[ -n "${CLUSTER_INFO_FAIL:-}" ]]; then
            echo "Unable to connect to the server: dial tcp 192.0.2.1:443: i/o timeout" >&2
            exit 1
        fi
        ;;
    *) exit 1 ;;
esac
EOF
chmod +x "${STUB_BIN}/aws" "${STUB_BIN}/kubectl"

readonly OLD_KUBECONFIG=$'apiVersion: v1\nkind: Config\nusers:\n- name: eks-user\n  user:\n    token: old-token'
readonly GET_TOKEN_CALL="aws eks get-token --cluster-name demo-cluster --region us-west-2 --output json"
readonly STORE_AND_RESTART="kubectl create secret target-kubeconfig
kubectl apply -f -
kubectl rollout restart deployment/applications-rp -n radius-system
kubectl rollout restart deployment/dynamic-rp -n radius-system
kubectl rollout restart deployment/bicep-de -n radius-system
kubectl rollout status deployment/applications-rp -n radius-system --timeout=300s
kubectl rollout status deployment/dynamic-rp -n radius-system --timeout=300s
kubectl rollout status deployment/bicep-de -n radius-system --timeout=300s"

# Prints the kubeconfig the steps write. With an argument, it also names that
# token file.
expected_kubeconfig() {
    printf 'apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: Q0EtREFUQQ==\n    server: https://eks.example\n  name: eks\ncontexts:\n- context:\n    cluster: eks\n    user: eks-user\n  name: eks\ncurrent-context: eks\nkind: Config\nusers:\n- name: eks-user\n  user:\n    token: eks-token-1'
    if [[ -n "${1:-}" ]]; then
        printf '\n    tokenFile: %s' "$1"
    fi
}

# Runs a step and prints its exit status. These steps set no `shell:`, so
# GitHub runs them with `bash -e`, without pipefail.
run_step() {
    local script="$1"
    local status=0

    rm -rf "${CALLS}" "${APPLIED}" "${TEST_ROOT}/runner"
    mkdir -p "${TEST_ROOT}/runner"
    : >"${CALLS}"
    PATH="${STUB_BIN}:${PATH}" RUNNER_TEMP="${TEST_ROOT}/runner" \
        RADIUS_TARGET_KUBECONFIG="${KUBECONFIG_PATH}" \
        bash --noprofile --norc -e "${script}" >"${STEP_LOG}" 2>&1 || status=$?
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

expect_kubeconfig() {
    local expected="$1"
    local context="$2"

    [[ "$(cat "${KUBECONFIG_PATH}")" == "${expected}" ]] ||
        fail "${context}: expected the kubeconfig:
${expected}
got:
$(cat "${KUBECONFIG_PATH}")"
}

expect_runner_temp_empty() {
    [[ -z "$(ls -A "${TEST_ROOT}/runner")" ]] ||
        fail "$1: expected the EKS token file to be removed from RUNNER_TEMP"
}

reset_kubeconfig() {
    mkdir -p "$(dirname "${KUBECONFIG_PATH}")"
    printf '%s\n' "${OLD_KUBECONFIG}" >"${KUBECONFIG_PATH}"
}

# A step that cannot mint an EKS token fails before it writes the kubeconfig or
# the Secret. Under `bash -e`, a failing aws piped into jq would not stop it.
expect_get_token_failure_stops() {
    local script="$1"
    local calls_before_token="$2"
    local context="$3"
    local before=""
    local mode
    local status

    if [[ -f "${KUBECONFIG_PATH}" ]]; then
        before="$(cat "${KUBECONFIG_PATH}")"
    fi
    for mode in fail empty; do
        if [[ -n "${before}" ]]; then
            printf '%s\n' "${before}" >"${KUBECONFIG_PATH}"
        else
            rm -f "${KUBECONFIG_PATH}"
        fi
        status="$(GET_TOKEN="${mode}" run_step "${script}")"
        [[ "${status}" != "0" ]] ||
            fail "${context}: expected get-token ${mode} to fail the step"
        expect_calls "${calls_before_token}${GET_TOKEN_CALL}" "${context} with get-token ${mode}"
        if [[ -n "${before}" ]]; then
            expect_kubeconfig "${before}" "${context} with get-token ${mode}"
        elif [[ -f "${KUBECONFIG_PATH}" ]]; then
            fail "${context}: expected no kubeconfig after get-token ${mode}"
        fi
        [[ ! -f "${APPLIED}" ]] ||
            fail "${context}: expected no Secret update after get-token ${mode}"
        expect_runner_temp_empty "${context} with get-token ${mode}"
    done
}

# The preflight outputs of a passing run.
export PREFLIGHT_ENDPOINT="https://eks.example"
export PREFLIGHT_CERTIFICATE_AUTHORITY="Q0EtREFUQQ=="

for workflow in run-rad-commands-aws.yml delete-aws.yml delete-environment-aws.yml; do
    connect="${TEST_ROOT}/${workflow%.yml}-connect.sh"
    refresh="${TEST_ROOT}/${workflow%.yml}-refresh.sh"
    no_endpoint="${TEST_ROOT}/${workflow%.yml}-no-endpoint.sh"
    VARS_AWS_ROLE_ARN="${ROLE}" VARS_AWS_EKS_CLUSTER_NAME="demo-cluster" \
        VARS_AWS_REGION="us-west-2" extract_step "${workflow}" "${CONNECT_STEP}" "${connect}"
    VARS_AWS_ROLE_ARN="${ROLE}" VARS_AWS_EKS_CLUSTER_NAME="demo-cluster" \
        VARS_AWS_REGION="us-west-2" extract_step "${workflow}" "${REFRESH_STEP}" "${refresh}"
    VARS_AWS_ROLE_ARN="${ROLE}" VARS_AWS_EKS_CLUSTER_NAME="demo-cluster" \
        VARS_AWS_REGION="us-west-2" PREFLIGHT_ENDPOINT="" \
        extract_step "${workflow}" "${CONNECT_STEP}" "${no_endpoint}"

    token_file="${POD_TOKEN_FILE}"
    expected_secret="$(printf 'kubeconfig<<\n%s\n>>\ntoken<<\neks-token-1\n>>' \
        "$(expected_kubeconfig "${token_file}")")"
    # delete-environment-aws.yml does not run cluster-info when connecting.
    if [[ "${workflow}" == delete-environment-aws.yml ]]; then
        cluster_info=""
    else
        cluster_info=$'\nkubectl cluster-info with the target kubeconfig'
    fi

    # Connecting writes a kubeconfig with the EKS token.
    rm -f "${KUBECONFIG_PATH}"
    mkdir -p "$(dirname "${KUBECONFIG_PATH}")"
    status="$(run_step "${connect}")"
    [[ "${status}" == "0" ]] || fail "${workflow}: expected connecting to succeed, got ${status}"
    expect_calls "${GET_TOKEN_CALL}${cluster_info}" "${workflow}: connecting"
    expect_kubeconfig "$(expected_kubeconfig)" "${workflow}: connecting"
    rm -f "${KUBECONFIG_PATH}"
    expect_get_token_failure_stops "${connect}" "" "${workflow}: connecting"

    # Without the preflight's endpoint, connecting stops with a coded error
    # before it asks AWS for a token.
    status="$(run_step "${no_endpoint}")"
    [[ "${status}" != "0" ]] || fail "${workflow}: expected connecting without an endpoint to fail"
    expect_calls "" "${workflow}: connecting without an endpoint"
    grep -qF "::error title=Preflight script error::[PREFLIGHT_ERROR] Preflight EKS access passed but returned no API server endpoint or certificate authority for 'demo-cluster'." "${STEP_LOG}" ||
        fail "${workflow}: connecting without an endpoint did not report PREFLIGHT_ERROR"
    [[ ! -f "${KUBECONFIG_PATH}" ]] || fail "${workflow}: expected no kubeconfig without an endpoint"

    # A cluster-info failure after the preflight passed is coded too, below the
    # kubectl error.
    if [[ -n "${cluster_info}" ]]; then
        status="$(CLUSTER_INFO_FAIL=1 run_step "${connect}")"
        [[ "${status}" != "0" ]] || fail "${workflow}: expected a cluster-info failure to fail the step"
        grep -qF "i/o timeout" "${STEP_LOG}" || fail "${workflow}: the kubectl error was not shown"
        grep -qF "::error title=EKS API server unreachable::[EKS_ENDPOINT_UNREACHABLE] kubectl cluster-info failed for 'demo-cluster', although Preflight EKS access passed." "${STEP_LOG}" ||
            fail "${workflow}: a cluster-info failure did not report EKS_ENDPOINT_UNREACHABLE"
        rm -f "${KUBECONFIG_PATH}"
    fi

    # Refreshing mints a new token and stores it, then restarts the three
    # consumers and waits for them.
    reset_kubeconfig
    status="$(run_step "${refresh}")"
    [[ "${status}" == "0" ]] || fail "${workflow}: expected the refresh to succeed, got ${status}"
    expect_calls "${GET_TOKEN_CALL}
${STORE_AND_RESTART}" "${workflow}: refreshing"
    expect_kubeconfig "$(expected_kubeconfig "${token_file}")" "${workflow}: refreshing"
    [[ "$(cat "${APPLIED}")" == "${expected_secret}" ]] ||
        fail "${workflow}: expected the Secret data:
${expected_secret}
got:
$(cat "${APPLIED}")"
    expect_runner_temp_empty "${workflow}: refreshing"
    if grep -q 'eks-token-1' "${STEP_LOG}"; then
        fail "${workflow}: the EKS token leaked to the step log"
    fi
    reset_kubeconfig
    expect_get_token_failure_stops "${refresh}" "" "${workflow}: refreshing"

    # Validate inputs requires the role and cluster in every AWS workflow, so
    # no workflow falls back to the control plane when the kubeconfig is
    # missing: the refresh still mints a token and stores a new kubeconfig.
    rm -f "${KUBECONFIG_PATH}"
    status="$(run_step "${refresh}")"
    [[ "${status}" == "0" ]] ||
        fail "${workflow}: expected the refresh without a kubeconfig to write one, got ${status}"
    expect_calls "${GET_TOKEN_CALL}
${STORE_AND_RESTART}" "${workflow}: refreshing without a kubeconfig"
    expect_kubeconfig "$(expected_kubeconfig "${token_file}")" "${workflow}: refreshing without a kubeconfig"
done

echo "refresh-target-credentials-aws tests passed"
