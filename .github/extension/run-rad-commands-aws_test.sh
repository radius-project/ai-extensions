#!/bin/bash

# Tests the AWS provider recipe-pack setup by extracting and executing the
# workflow's real run block with deterministic rad, curl, and contrib-catalog
# stubs. The pack it downloads is the pinned aws-eks pack snapshot.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly WORKFLOW_FILE="${SCRIPT_DIR}/run-rad-commands-aws.yml"
readonly PACK_FIXTURE="${REPO_ROOT}/packages/core/src/modeling/testdata/aws-eks.bicep"

TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

readonly BODY_SCRIPT="${TEST_ROOT}/provider-setup.sh"
readonly STUB_BIN="${TEST_ROOT}/bin"
readonly CATALOG_HELPER="${TEST_ROOT}/contrib-catalog.sh"
readonly CALLS="${TEST_ROOT}/calls.log"
readonly OUTPUT="${TEST_ROOT}/output.log"
readonly PACK_URL="https://raw.githubusercontent.com/radius-project/resource-types-contrib/0123456789abcdef0123456789abcdef01234567/recipe-packs/aws-eks/aws-eks.bicep"

fail() {
    echo "FAIL: $*" >&2
    if [ -f "${OUTPUT}" ]; then
        cat "${OUTPUT}" >&2
    fi
    exit 1
}

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 is required to parse run-rad-commands-aws.yml"
fi

extract_provider_setup_step() {
    python3 - "${WORKFLOW_FILE}" "${BODY_SCRIPT}" <<'PYTHON'
import re
import sys

workflow_file, out_file = sys.argv[1], sys.argv[2]
lines = open(workflow_file, encoding="utf-8").read().splitlines()
step = "Create Radius environment and deploy provider recipe pack"

names = [
    i for i, line in enumerate(lines)
    if re.match(r"^\s*-\s+name:\s+" + re.escape(step) + r"\s*$", line)
]
if len(names) != 1:
    sys.exit("expected one '%s' step, found %d" % (step, len(names)))

run_at = None
pack_url = None
step_indent = len(lines[names[0]]) - len(lines[names[0]].lstrip(" "))
for i in range(names[0] + 1, len(lines)):
    line = lines[i]
    indent = len(line) - len(line.lstrip(" "))
    if line.strip() and indent <= step_indent:
        break
    match = re.match(r"^\s*RECIPE_PACK_URL:\s*(.+?)\s*$", line)
    if match:
        pack_url = match.group(1)
    if re.match(r"^\s*run:\s*\|\s*$", line):
        run_at = i
        break

if pack_url != "'{{AWS_EKS_RECIPE_PACK_URL}}'":
    sys.exit("RECIPE_PACK_URL must come from the generator's pinned pack, got %r" % pack_url)
if run_at is None:
    sys.exit("provider setup step has no 'run: |' block")

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
    cat >"${STUB_BIN}/rad" <<'STUB'
#!/bin/bash
echo "rad $*" >>"${CALLS}"
STUB
    cat >"${STUB_BIN}/curl" <<'STUB'
#!/bin/bash
echo "curl $*" >>"${CALLS}"
out=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
        out="$2"
        shift
    fi
    shift
done
cp "${PACK_FIXTURE}" "${out}"
STUB
    # The workflow runs on GNU sed. Map its in-place form for a BSD sed host.
    if ! sed --version >/dev/null 2>&1; then
        cat >"${STUB_BIN}/sed" <<'STUB'
#!/bin/bash
if [ "$1" = "-i" ]; then
    shift
    exec /usr/bin/sed -i '' "$@"
fi
exec /usr/bin/sed "$@"
STUB
    fi
    chmod +x "${STUB_BIN}"/*
    cat >"${CATALOG_HELPER}" <<'STUB'
radius_contrib_kube_recipe_source() {
    printf 'ghcr.io/radius-project/kube-recipes/%s:pinned0123\n' "$2"
}
STUB
}

# Run the extracted step in a fresh workspace. Extra arguments are NAME=value
# overrides for the environment the step reads.
run_step() {
    rm -rf "${TEST_ROOT}/work" "${CALLS}" "${OUTPUT}"
    mkdir -p "${TEST_ROOT}/work"
    : >"${CALLS}"
    (
        cd "${TEST_ROOT}/work"
        env \
            PATH="${STUB_BIN}:${PATH}" \
            CALLS="${CALLS}" \
            PACK_FIXTURE="${PACK_FIXTURE}" \
            RADIUS_CONTRIB_CATALOG_HELPER="${CATALOG_HELPER}" \
            GITHUB_OUTPUT="${TEST_ROOT}/work/github-output" \
            ENVIRONMENT=dev \
            APP_FILE=.radius/app.bicep \
            KUBERNETES_NAMESPACE=apps \
            RADIUS_BUILD_REGISTRY=ghcr.io/Octo/App \
            RADIUS_ROUTES_GATEWAY_NAME=radius \
            RADIUS_ROUTES_GATEWAY_NAMESPACE=radius-system \
            AWS_ACCOUNT_ID=123456789012 \
            AWS_REGION=us-west-2 \
            AWS_EKS_CLUSTER_NAME=dev-cluster \
            RADIUS_SUBNET_IDS=subnet-0a1,subnet-0b2 \
            RECIPE_PACK_URL="${PACK_URL}" \
            "$@" \
            bash -e "${BODY_SCRIPT}"
    ) >"${OUTPUT}" 2>&1
}

test_deploys_the_pinned_pack_with_its_parameters() {
    run_step || fail "valid AWS inputs should deploy the recipe pack"
    local work="${TEST_ROOT}/work"
    grep -qxF "curl -fsSL ${PACK_URL} -o .radius/radius-recipe-pack.bicep" "${CALLS}" ||
        fail "the pack was not downloaded from the pinned URL"
    grep -qxF "rad deploy .radius/radius-environment.bicep" "${CALLS}" ||
        fail "the environment was not deployed"
    grep -qxF "rad deploy .radius/radius-recipe-pack.bicep --environment dev --parameters eksClusterName=dev-cluster --parameters subnetIds=subnet-0a1,subnet-0b2 --parameters routesGatewayName=radius --parameters routesGatewayNamespace=radius-system --parameters containerImagesRegistry=ghcr.io/octo/app --parameters containerImagesRegistrySecretName=radius-ghcr-registry-creds" "${CALLS}" ||
        fail "the recipe pack was not deployed with the aws-eks parameters"
    grep -qF "accountId: '123456789012'" "${work}/.radius/radius-environment.bicep" ||
        fail "the environment does not carry the AWS account"
    grep -qF "region: 'us-west-2'" "${work}/.radius/radius-environment.bicep" ||
        fail "the environment does not carry the AWS region"
    grep -qF "namespace: 'apps'" "${work}/.radius/radius-environment.bicep" ||
        fail "the environment does not carry the Kubernetes namespace"
    if grep -q "kube-recipes/[a-z]*:latest" "${work}/.radius/radius-recipe-pack.bicep"; then
        fail "a Kubernetes recipe was left on its mutable latest tag"
    fi
    grep -qF "kube-recipes/containers:pinned0123" "${work}/.radius/radius-recipe-pack.bicep" ||
        fail "the containers recipe was not pinned"
    grep -qF "aws-eks-recipes/mysqldatabases:latest" "${work}/.radius/radius-recipe-pack.bicep" ||
        fail "the MySQL recipe source changed"
    grep -qxF "provider-pack=aws-eks" "${work}/github-output" ||
        fail "the provider pack name was not exposed"
}

test_refuses_invalid_input_before_any_change() {
    local name="$1" value="$2" message="$3"
    if run_step "${name}=${value}"; then
        fail "${name}=${value} should be refused"
    fi
    grep -qF "${message}" "${OUTPUT}" || fail "${name}=${value} did not explain: ${message}"
    if [ -s "${CALLS}" ]; then
        fail "${name}=${value} reached rad or curl"
    fi
}

extract_provider_setup_step
write_stubs
test_deploys_the_pinned_pack_with_its_parameters
test_refuses_invalid_input_before_any_change AWS_ACCOUNT_ID 12345678901 "AWS_ACCOUNT_ID must be"
test_refuses_invalid_input_before_any_change AWS_ACCOUNT_ID "123456789012'" "AWS_ACCOUNT_ID must be"
test_refuses_invalid_input_before_any_change AWS_REGION "us-west-2'}" "AWS_REGION must be"
test_refuses_invalid_input_before_any_change AWS_REGION "" "AWS_REGION must be"
test_refuses_invalid_input_before_any_change AWS_EKS_CLUSTER_NAME "dev cluster" "AWS_EKS_CLUSTER_NAME must be"
test_refuses_invalid_input_before_any_change AWS_EKS_CLUSTER_NAME "" "AWS_EKS_CLUSTER_NAME must be"
test_refuses_invalid_input_before_any_change RADIUS_SUBNET_IDS "subnet-0a1, subnet-0b2" "RADIUS_SUBNET_IDS must be"
test_refuses_invalid_input_before_any_change RADIUS_SUBNET_IDS '["subnet-0a1"]' "RADIUS_SUBNET_IDS must be"
test_refuses_invalid_input_before_any_change RADIUS_SUBNET_IDS "" "RADIUS_SUBNET_IDS must be"

echo "AWS provider recipe-pack setup tests passed"
