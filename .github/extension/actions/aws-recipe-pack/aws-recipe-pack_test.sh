#!/bin/bash

# ============================================================================
# Unit tests for the aws-recipe-pack action's script.
#
# `rad` and the Bicep compiler are stubbed: there is no control plane, no
# registry, and no network. The `rad` stub logs every call and keeps a copy of
# the generated recipe pack, so the tests assert what the pack would deploy.
# The stub compiler reports each recipe's real `param` declarations, so the
# per-recipe parameter selection runs against the checked-in recipes.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly TARGET="${SCRIPT_DIR}/aws-recipe-pack.sh"

TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

readonly STUB_BIN="${TEST_ROOT}/bin"
mkdir -p "${STUB_BIN}"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

cat > "${STUB_BIN}/rad" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${RAD_CALL_LOG}"
if [[ "$1" == "deploy" ]]; then
    case "$(basename "$2")" in
        environment.bicep)
            n=$(find "${CAPTURE_DIR}" -name 'environment-*.bicep' | wc -l | tr -d ' ')
            cp "$2" "${CAPTURE_DIR}/environment-${n}.bicep"
            ;;
        aws-recipe-pack.bicep)
            cp "$(dirname "$2")/recipes.json" "${CAPTURE_DIR}/recipes.json"
            ;;
    esac
fi
EOF

# Emits the compiled template's parameter names from the recipe's `param` lines.
cat > "${STUB_BIN}/bicep" <<'EOF'
#!/bin/bash
set -euo pipefail
[[ "$1" == "build" && "$3" == "--stdout" ]] || { echo "unexpected bicep call: $*" >&2; exit 1; }
sed -nE 's/^param ([A-Za-z0-9_]+) .*/\1/p' "$2" | jq -R . | jq -s 'map({(.): {}}) | add // {} | {parameters: .}'
EOF
chmod +x "${STUB_BIN}/rad" "${STUB_BIN}/bicep"

cat > "${TEST_ROOT}/catalog-helper.sh" <<'EOF'
radius_contrib_kube_recipe_source() {
    printf 'ghcr.io/radius-project/kube-recipes/%s:catalogref' "$2"
}
EOF

# Runs the script with valid inputs; extra `NAME=value` arguments override them.
run_script() {
    local case_dir="${TEST_ROOT}/case-$1"
    shift
    rm -rf "${case_dir}"
    mkdir -p "${case_dir}/capture"
    : > "${case_dir}/output"
    : > "${case_dir}/rad.log"
    env \
        PATH="${STUB_BIN}:${PATH}" \
        HOME="${case_dir}" \
        RUNNER_TEMP="${case_dir}" \
        RAD_CALL_LOG="${case_dir}/rad.log" \
        CAPTURE_DIR="${case_dir}/capture" \
        GITHUB_OUTPUT="${case_dir}/output" \
        BICEP_BIN="${STUB_BIN}/bicep" \
        ACTION_PATH="${SCRIPT_DIR}" \
        RADIUS_CONTRIB_CATALOG_HELPER="${TEST_ROOT}/catalog-helper.sh" \
        ENVIRONMENT="aws-dev" \
        NAMESPACE="todo-aws-dev" \
        AWS_ACCOUNT_ID="123456789012" \
        AWS_REGION="us-west-2" \
        EKS_CLUSTER_NAME="demo-cluster" \
        VPC_ID="vpc-0abc" \
        SUBNET_IDS="subnet-0aa,subnet-0bb" \
        BUILD_REGISTRY="ghcr.io/Octo/App" \
        REGISTRY_SECRET_NAME="radius-ghcr-registry-creds" \
        ROUTES_GATEWAY_NAME="radius-gateway" \
        ROUTES_GATEWAY_NAMESPACE="radius-system" \
        REGISTRY_USERNAME="octo" \
        REGISTRY_PASSWORD="fake-token" \
        RECIPE_REGISTRY="ghcr.io/octo/app" \
        "$@" \
        bash "${TARGET}" > "${case_dir}/stdout" 2> "${case_dir}/stderr"
}

case_dir() {
    printf '%s/case-%s' "${TEST_ROOT}" "$1"
}

test_deploys_aws_recipes_and_kubernetes_primitives() {
    run_script success || fail "success case exited non-zero: $(cat "$(case_dir success)/stderr")"
    local dir pack
    dir="$(case_dir success)"
    pack="${dir}/capture/recipes.json"
    [[ -f "${pack}" ]] || fail "the recipe pack was not deployed"

    local expected_types
    expected_types=$(jq -cn '[
        "Radius.AI/models", "Radius.AI/search",
        "Radius.Compute/containerImages", "Radius.Compute/containers",
        "Radius.Compute/persistentVolumes", "Radius.Compute/routes",
        "Radius.Data/mongoDatabases", "Radius.Data/mySqlDatabases",
        "Radius.Data/postgreSqlDatabases", "Radius.Data/redisCaches",
        "Radius.Data/sqlServerDatabases", "Radius.Messaging/rabbitMQ",
        "Radius.Security/secrets", "Radius.Storage/objectStorage"
    ]')
    [[ "$(jq -c 'keys' "${pack}")" == "${expected_types}" ]] \
        || fail "unexpected recipe types: $(jq -c 'keys' "${pack}")"

    jq -e '.["Radius.Data/mySqlDatabases"].source
        | test("^ghcr\\.io/octo/app/radius-aws-recipes/mysql:[0-9a-f]{12}$")' "${pack}" >/dev/null \
        || fail "mysql recipe source is not the published content-addressed tag"
    jq -e '.["Radius.Data/mySqlDatabases"].parameters
        == {eksClusterName: "demo-cluster", subnetIds: "subnet-0aa,subnet-0bb"}' "${pack}" >/dev/null \
        || fail "mysql received parameters it does not declare: $(jq -c '.["Radius.Data/mySqlDatabases"].parameters' "${pack}")"
    jq -e '.["Radius.AI/search"].parameters
        == {eksClusterName: "demo-cluster", subnetIds: "subnet-0aa,subnet-0bb", region: "us-west-2", accountId: "123456789012"}' \
        "${pack}" >/dev/null || fail "search parameters are wrong"
    jq -e '.["Radius.AI/models"].parameters == {region: "us-west-2"}' "${pack}" >/dev/null \
        || fail "models parameters are wrong"

    jq -e '.["Radius.Messaging/rabbitMQ"].source == "ghcr.io/radius-project/kube-recipes/rabbitmq:catalogref"' \
        "${pack}" >/dev/null || fail "rabbitMQ must use the pinned Kubernetes recipe"
    jq -e '.["Radius.Compute/containerImages"].parameters
        == {registry: "ghcr.io/octo/app", registrySecretName: "radius-ghcr-registry-creds"}' "${pack}" >/dev/null \
        || fail "containerImages must push to the lowercased build registry"
    jq -e '.["Radius.Compute/routes"].parameters
        == {gatewayName: "radius-gateway", gatewayNamespace: "radius-system"}' "${pack}" >/dev/null \
        || fail "routes gateway parameters are wrong"

    grep -q "No AWS recipe for Radius.Messaging/kafka" "${dir}/stdout" \
        || fail "a type without a recipe must be reported"
    grep -qx "recipe-pack=aws-bicep" "${dir}/output" || fail "recipe-pack output was not written"

    [[ "$(grep -c '^bicep publish' "${dir}/rad.log")" == "8" ]] \
        || fail "expected one publish per checked-in recipe: $(grep '^bicep publish' "${dir}/rad.log")"
    grep -q '^deploy .*/registry.bicep --environment aws-dev ' "${dir}/rad.log" \
        || fail "registry credentials were not deployed to the environment"

    grep -q "namespace: 'todo-aws-dev'" "${dir}/capture/environment-0.bicep" \
        || fail "environment must use the requested namespace"
    grep -q "accountId: '123456789012'" "${dir}/capture/environment-0.bicep" \
        || fail "environment must carry the AWS account"
    if grep -q "bicepSettings" "${dir}/capture/environment-0.bicep"; then
        fail "the first environment deploy must not reference settings that do not exist yet"
    fi
    grep -q "bicepSettings: settings.id" "${dir}/capture/environment-1.bicep" \
        || fail "the environment must reference the registry settings"
}

test_accepts_json_array_subnets() {
    run_script json-subnets 'SUBNET_IDS=["subnet-0aa", "subnet-0bb"]' \
        || fail "JSON array subnets were rejected: $(cat "$(case_dir json-subnets)/stderr")"
    jq -e '.["Radius.Data/mySqlDatabases"].parameters.subnetIds == "subnet-0aa,subnet-0bb"' \
        "$(case_dir json-subnets)/capture/recipes.json" >/dev/null \
        || fail "JSON array subnets must be passed as a comma-separated list"
}

test_rejects_invalid_input() {
    local name="$1" override="$2" message="$3"
    if run_script "${name}" "${override}"; then
        fail "${name}: expected failure"
    fi
    grep -qF "${message}" "$(case_dir "${name}")/stderr" \
        || fail "${name}: missing error '${message}': $(cat "$(case_dir "${name}")/stderr")"
    [[ ! -s "$(case_dir "${name}")/rad.log" ]] || fail "${name}: rad ran before input validation"
}

# Every parameter a recipe declares without a default must be one the pack
# supplies, or the recipe could never be deployed.
test_recipes_only_require_supplied_parameters() {
    local recipe missing
    for recipe in "${SCRIPT_DIR}"/recipes/*.bicep; do
        missing=$(sed -nE 's/^param ([A-Za-z0-9_]+) [A-Za-z]+[[:space:]]*$/\1/p' "${recipe}" \
            | grep -vxE 'context|eksClusterName|subnetIds|vpcId|region|accountId' || true)
        [[ -z "${missing}" ]] || fail "$(basename "${recipe}") requires parameters the pack never passes: ${missing}"
    done
}

test_deploys_aws_recipes_and_kubernetes_primitives
test_accepts_json_array_subnets
test_rejects_invalid_input bad-account "AWS_ACCOUNT_ID=12345" "is not a 12-digit account ID"
test_rejects_invalid_input bad-region "AWS_REGION=us_west_2" "is not an AWS region"
test_rejects_invalid_input bad-cluster "EKS_CLUSTER_NAME=-bad" "is not an EKS cluster name"
test_rejects_invalid_input bad-vpc "VPC_ID=vpc-XYZ" "is not a VPC ID"
test_rejects_invalid_input empty-subnets "SUBNET_IDS=," "RADIUS_SUBNET_IDS must list subnet IDs"
test_rejects_invalid_input injected-subnet "SUBNET_IDS=subnet-0aa,'x'" "RADIUS_SUBNET_IDS must list subnet IDs"
test_rejects_invalid_input upper-registry "RECIPE_REGISTRY=ghcr.io/Octo/app" "must be a lowercase ghcr.io path"
test_recipes_only_require_supplied_parameters

echo "aws-recipe-pack tests passed"
