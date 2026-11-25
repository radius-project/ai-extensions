#!/bin/bash

# Tests the AWS environment delete's credential refresh by extracting and
# executing the workflow's real run block with deterministic aws, jq, and
# kubectl stubs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly WORKFLOW_FILE="${SCRIPT_DIR}/delete-environment-aws.yml"

TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

readonly BODY_SCRIPT="${TEST_ROOT}/refresh.sh"
readonly STUB_BIN="${TEST_ROOT}/bin"
readonly CALLS="${TEST_ROOT}/calls.log"
readonly OUTPUT="${TEST_ROOT}/output.log"
readonly KUBECONFIG_FILE="${TEST_ROOT}/target-cluster"

fail() {
    echo "FAIL: $*" >&2
    if [ -f "${OUTPUT}" ]; then
        cat "${OUTPUT}" >&2
    fi
    exit 1
}

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 is required to parse delete-environment-aws.yml"
fi

extract_refresh_step() {
    python3 - "${WORKFLOW_FILE}" "${BODY_SCRIPT}" <<'PYTHON'
import re
import sys

workflow_file, out_file = sys.argv[1], sys.argv[2]
lines = open(workflow_file, encoding="utf-8").read().splitlines()
step = "Refresh external deployment target credentials"

names = [
    i for i, line in enumerate(lines)
    if re.match(r"^\s*-\s+name:\s+" + re.escape(step) + r"\s*$", line)
]
if len(names) != 1:
    sys.exit("expected one '%s' step, found %d" % (step, len(names)))

run_at = None
env = {}
step_indent = len(lines[names[0]]) - len(lines[names[0]].lstrip(" "))
for i in range(names[0] + 1, len(lines)):
    line = lines[i]
    indent = len(line) - len(line.lstrip(" "))
    if line.strip() and indent <= step_indent:
        break
    match = re.match(r"^\s*(CLUSTER|REGION):\s*(.+?)\s*$", line)
    if match:
        env[match.group(1)] = match.group(2)
    if re.match(r"^\s*run:\s*\|\s*$", line):
        run_at = i
        break

expected = {
    "CLUSTER": "${{ vars.AWS_EKS_CLUSTER_NAME }}",
    "REGION": "${{ vars.AWS_REGION }}",
}
if env != expected:
    sys.exit("cluster and region must arrive through env, got %r" % env)
if run_at is None:
    sys.exit("refresh step has no 'run: |' block")

body, base = [], None
for line in lines[run_at + 1:]:
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
open(out_file, "w", encoding="utf-8").write("\n".join(body) + "\n")
PYTHON
}

write_stubs() {
    mkdir -p "${STUB_BIN}"
    cat >"${STUB_BIN}/aws" <<'STUB'
#!/bin/bash
echo "aws $*" >>"${CALLS}"
case "$*" in
    *cluster.endpoint*) echo "https://eks.test" ;;
    *certificateAuthority.data*) echo "Q0EtREFUQQ==" ;;
    *get-token*) echo '{"status":{"token":"fresh-token"}}' ;;
esac
STUB
    cat >"${STUB_BIN}/kubectl" <<'STUB'
#!/bin/bash
echo "kubectl $*" >>"${CALLS}"
if [ "$1" = create ]; then
    cat "${KUBECONFIG_FILE}" >>"${CALLS}"
fi
STUB
    chmod +x "${STUB_BIN}"/*
}

run_step() {
    rm -f "${CALLS}" "${OUTPUT}"
    : >"${CALLS}"
    env \
        PATH="${STUB_BIN}:${PATH}" \
        CALLS="${CALLS}" \
        KUBECONFIG_FILE="${KUBECONFIG_FILE}" \
        RADIUS_TARGET_KUBECONFIG="${KUBECONFIG_FILE}" \
        CLUSTER=dev-cluster \
        REGION=us-west-2 \
        bash -e "${BODY_SCRIPT}" >"${OUTPUT}" 2>&1
}

test_refreshes_the_token_before_publishing_the_kubeconfig() {
    printf 'token: stale-token\n' >"${KUBECONFIG_FILE}"
    run_step || fail "the refresh step should succeed"
    grep -qxF "aws eks get-token --cluster-name dev-cluster --region us-west-2 --output json" "${CALLS}" ||
        fail "the step did not mint a token for the environment's cluster and region"
    token_line="$(grep -n "aws eks get-token" "${CALLS}" | cut -d: -f1)"
    secret_line="$(grep -n "kubectl create secret generic target-kubeconfig" "${CALLS}" | cut -d: -f1)"
    ((token_line < secret_line)) ||
        fail "the token was not refreshed before the kubeconfig was published"
    grep -qF "token: fresh-token" "${CALLS}" ||
        fail "the published kubeconfig does not carry the fresh token"
    if grep -qF "stale-token" "${CALLS}"; then
        fail "the published kubeconfig still carries the stale token"
    fi
    grep -qF "server: https://eks.test" "${KUBECONFIG_FILE}" ||
        fail "the kubeconfig does not name the cluster endpoint"
}

test_skips_without_a_target_cluster() {
    rm -f "${KUBECONFIG_FILE}"
    run_step || fail "the refresh step should succeed without a target cluster"
    if [ -s "${CALLS}" ]; then
        fail "the step called aws or kubectl without a target cluster"
    fi
}

extract_refresh_step
write_stubs
test_refreshes_the_token_before_publishing_the_kubeconfig
test_skips_without_a_target_cluster

echo "AWS environment delete credential refresh tests passed"
