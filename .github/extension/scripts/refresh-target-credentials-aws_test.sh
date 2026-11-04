#!/bin/bash

# Tests the "Refresh external deployment target credentials" step of
# run-rad-commands-aws.yml and delete-aws.yml by running its real script with
# fake aws and kubectl. With an EKS cluster, the step must write a kubeconfig
# that carries the EKS token inline and names the pods' token file, and store
# that token under the target-kubeconfig Secret's `token` key, which the token
# refresher keeps current.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly WORKFLOW_DIR="${SCRIPT_DIR}/.."
readonly REFRESHER="${SCRIPT_DIR}/refresh-aws-tokens.sh"
readonly STEP="Refresh external deployment target credentials"
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

# The step must point tokenFile at the path where the refresher's `token` key is
# mounted in the pods.
POD_TOKEN_FILE="$(sed -n 's/^readonly POD_TOKEN_FILE="\(.*\)"$/\1/p' "${REFRESHER}")"
readonly POD_TOKEN_FILE
[[ "${POD_TOKEN_FILE}" == /etc/radius/target-kubeconfig/token ]] ||
    fail "expected the refresher to write the token mounted at /etc/radius/target-kubeconfig/token, got '${POD_TOKEN_FILE}'"

# Writes the step's script with each `${{ vars.NAME }}` replaced by the value of
# the environment variable VARS_NAME, as GitHub does before running it.
extract_step() {
    local workflow="$1"
    local out="$2"

    python3 - "${WORKFLOW_DIR}/${workflow}" "${STEP}" "${out}" <<'PYTHON'
import os
import re
import sys

workflow_file, step, out_file = sys.argv[1:4]
lines = open(workflow_file, encoding="utf-8").read().splitlines()
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
script = "\n".join(body) + "\n"

def substitute(match):
    return os.environ.get("VARS_" + match.group(1), "")

script = re.sub(r"\$\{\{\s*vars\.([A-Z_]+)\s*\}\}", substitute, script)
if "${{" in script:
    sys.exit("unsubstituted expression left in step '%s'" % step)
open(out_file, "w", encoding="utf-8").write(script)
PYTHON
}

mkdir -p "${STUB_BIN}"
cat >"${STUB_BIN}/aws" <<'EOF'
#!/bin/bash
printf 'aws %s\n' "$*" >>"${CALLS}"
case "$*" in
    *"cluster.endpoint"*) echo "https://eks.example" ;;
    *"cluster.certificateAuthority.data"*) echo "Q0EtREFUQQ==" ;;
    "eks get-token "*) echo '{"kind":"ExecCredential","status":{"token":"eks-token-1"}}' ;;
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
    apply) cat >"${APPLIED}" ;;
    rollout) printf 'kubectl %s\n' "$*" >>"${CALLS}" ;;
    *) exit 1 ;;
esac
EOF
chmod +x "${STUB_BIN}/aws" "${STUB_BIN}/kubectl"

readonly OLD_KUBECONFIG=$'apiVersion: v1\nkind: Config\nusers:\n- name: eks-user\n  user:\n    token: old-token'

expected_kubeconfig() {
    printf 'apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: Q0EtREFUQQ==\n    server: https://eks.example\n  name: eks\ncontexts:\n- context:\n    cluster: eks\n    user: eks-user\n  name: eks\ncurrent-context: eks\nkind: Config\nusers:\n- name: eks-user\n  user:\n    token: eks-token-1\n    tokenFile: %s' \
        "${POD_TOKEN_FILE}"
}

# Runs the step as GitHub runs a bash step and prints its exit status.
run_step() {
    local script="$1"
    local status=0

    rm -rf "${CALLS}" "${APPLIED}" "${TEST_ROOT}/runner"
    mkdir -p "${TEST_ROOT}/runner"
    : >"${CALLS}"
    PATH="${STUB_BIN}:${PATH}" RUNNER_TEMP="${TEST_ROOT}/runner" \
        RADIUS_TARGET_KUBECONFIG="${KUBECONFIG_PATH}" \
        bash --noprofile --norc -eo pipefail "${script}" >"${STEP_LOG}" 2>&1 || status=$?
    printf '%s' "${status}"
}

for workflow in run-rad-commands-aws.yml delete-aws.yml; do
    eks_step="${TEST_ROOT}/${workflow%.yml}-eks.sh"
    no_cluster_step="${TEST_ROOT}/${workflow%.yml}-no-cluster.sh"
    VARS_AWS_ROLE_ARN="${ROLE}" VARS_AWS_EKS_CLUSTER_NAME="demo-cluster" \
        VARS_AWS_REGION="us-west-2" extract_step "${workflow}" "${eks_step}"
    VARS_AWS_ROLE_ARN="${ROLE}" VARS_AWS_EKS_CLUSTER_NAME="" \
        VARS_AWS_REGION="us-west-2" extract_step "${workflow}" "${no_cluster_step}"

    # With an EKS cluster, the kubeconfig and Secret carry both token forms.
    mkdir -p "$(dirname "${KUBECONFIG_PATH}")"
    printf '%s\n' "${OLD_KUBECONFIG}" >"${KUBECONFIG_PATH}"
    status="$(run_step "${eks_step}")"
    [[ "${status}" == "0" ]] || fail "${workflow}: expected the step to succeed, got ${status}"
    [[ "$(cat "${KUBECONFIG_PATH}")" == "$(expected_kubeconfig)" ]] ||
        fail "${workflow}: expected the kubeconfig to carry the EKS token inline and in tokenFile, got:
$(cat "${KUBECONFIG_PATH}")"
    expected_secret="$(printf 'kubeconfig<<\n%s\n>>\ntoken<<\neks-token-1\n>>' "$(expected_kubeconfig)")"
    [[ "$(cat "${APPLIED}")" == "${expected_secret}" ]] ||
        fail "${workflow}: expected the Secret to hold the kubeconfig and the token key, got:
$(cat "${APPLIED}")"
    grep -Fq "aws eks get-token --cluster-name demo-cluster --region us-west-2 --output json" "${CALLS}" ||
        fail "${workflow}: expected an EKS token for the configured cluster and region"
    for consumer in applications-rp dynamic-rp bicep-de; do
        restarts="$(grep -cFx "kubectl rollout restart deployment/${consumer} -n radius-system" "${CALLS}" || true)"
        [[ "${restarts}" == "1" ]] ||
            fail "${workflow}: expected ${consumer} in radius-system to restart once, got ${restarts}"
    done
    [[ "$(grep -c '^kubectl rollout restart ' "${CALLS}" || true)" == "3" ]] ||
        fail "${workflow}: expected no restarts beyond the three consumers"
    [[ -z "$(ls -A "${TEST_ROOT}/runner")" ]] ||
        fail "${workflow}: expected the EKS token file to be removed from RUNNER_TEMP"
    if grep -q 'eks-token-1' "${STEP_LOG}"; then
        fail "${workflow}: the EKS token leaked to the step log"
    fi

    # Without an EKS cluster, the step stores the existing kubeconfig unchanged.
    printf '%s\n' "${OLD_KUBECONFIG}" >"${KUBECONFIG_PATH}"
    status="$(run_step "${no_cluster_step}")"
    [[ "${status}" == "0" ]] || fail "${workflow}: expected the step without a cluster to succeed, got ${status}"
    [[ "$(cat "${KUBECONFIG_PATH}")" == "${OLD_KUBECONFIG}" ]] ||
        fail "${workflow}: expected the kubeconfig to stay unchanged without a cluster"
    [[ "$(cat "${APPLIED}")" == "$(printf 'kubeconfig<<\n%s\n>>' "${OLD_KUBECONFIG}")" ]] ||
        fail "${workflow}: expected only the kubeconfig key without a cluster, got:
$(cat "${APPLIED}")"
    if grep -q '^aws ' "${CALLS}"; then
        fail "${workflow}: expected no AWS call without a cluster"
    fi

    # Without a target kubeconfig, the step leaves the control plane alone.
    rm -f "${KUBECONFIG_PATH}"
    status="$(run_step "${eks_step}")"
    [[ "${status}" == "0" ]] || fail "${workflow}: expected the step without a kubeconfig to succeed, got ${status}"
    [[ ! -s "${CALLS}" && ! -f "${APPLIED}" ]] ||
        fail "${workflow}: expected no AWS or kubectl call without a target kubeconfig"
done

echo "refresh-target-credentials-aws tests passed"
