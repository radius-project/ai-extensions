#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT="${SCRIPT_DIR}/attach-recipe-pack.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
readonly REPO_ROOT
readonly AZURE_WORKFLOW="${REPO_ROOT}/.github/extension/run-rad-commands-azure.yml"
readonly AWS_WORKFLOW="${REPO_ROOT}/.github/extension/run-rad-commands-aws.yml"

TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT
readonly BIN="${TEST_ROOT}/bin"
readonly CALLS="${TEST_ROOT}/calls.log"
readonly OUTPUT="${TEST_ROOT}/output.log"
mkdir -p "${BIN}"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

cat >"${BIN}/rad" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'rad %s\n' "$*" >>"${CALLS}"
case "${1:-} ${2:-}" in
    "recipe-pack show")
        [[ "${SHOW_FAIL:-false}" != true ]]
        printf '%s\n' "${PACK_JSON}"
        ;;
    "env update")
        [[ "${UPDATE_FAIL:-false}" != true ]]
        ;;
    *)
        echo "unexpected rad command: $*" >&2
        exit 91
        ;;
esac
EOF
chmod +x "${BIN}/rad"

run_script() {
    local expected_exit="$1"
    shift
    : >"${CALLS}"
    if env PATH="${BIN}:${PATH}" CALLS="${CALLS}" "$@" \
        bash "${SCRIPT}" >"${OUTPUT}" 2>&1; then
        [[ "${expected_exit}" == success ]] ||
            fail "script unexpectedly succeeded"
    else
        [[ "${expected_exit}" == failure ]] ||
            fail "script unexpectedly failed: $(cat "${OUTPUT}")"
    fi
}

assert_call() {
    grep -Fxq "$1" "${CALLS}" ||
        fail "missing call '$1'; calls: $(cat "${CALLS}")"
}

assert_no_call() {
    if grep -Fq "$1" "${CALLS}"; then
        fail "unexpected call containing '$1'; calls: $(cat "${CALLS}")"
    fi
}

assert_output() {
    grep -Fq "$1" "${OUTPUT}" ||
        fail "missing output '$1'; output: $(cat "${OUTPUT}")"
}

PACK_ID="/planes/radius/local/resourceGroups/default/providers/Radius.Core/recipePacks/azure-avm"
run_script success \
    ENVIRONMENT=production \
    RECIPE_PACK=azure-avm \
    PACK_JSON="{\"id\":\"${PACK_ID}\"}"
assert_call "rad recipe-pack show azure-avm -o json"
assert_call "rad env update production --recipe-packs ${PACK_ID} --preview"

run_script failure RECIPE_PACK=azure-avm PACK_JSON='{"id":"pack"}'
assert_output "Radius environment name is required"
assert_no_call "rad "

run_script failure ENVIRONMENT=production PACK_JSON='{"id":"pack"}'
assert_output "Recipe pack name is required"
assert_no_call "rad "

for invalid_json in '{}' '{"id":""}' '{"id":42}' 'not-json'; do
    run_script failure \
        ENVIRONMENT=production \
        RECIPE_PACK=azure-avm \
        PACK_JSON="${invalid_json}"
    assert_output "returned an invalid resource ID"
    assert_call "rad recipe-pack show azure-avm -o json"
    assert_no_call "rad env update"
done

run_script failure \
    ENVIRONMENT=production \
    RECIPE_PACK=azure-avm \
    PACK_JSON='{"id":"pack"}' \
    SHOW_FAIL=true
assert_call "rad recipe-pack show azure-avm -o json"
assert_no_call "rad env update"

run_script failure \
    ENVIRONMENT=production \
    RECIPE_PACK=azure-avm \
    PACK_JSON='{"id":"pack"}' \
    UPDATE_FAIL=true
assert_call "rad env update production --recipe-packs pack --preview"

for workflow in "${AZURE_WORKFLOW}" "${AWS_WORKFLOW}"; do
    create_line="$(
        grep -n 'name: Create Radius environment and deploy provider recipe pack' \
            "${workflow}" | cut -d: -f1
    )"
    attach_line="$(grep -n 'name: Attach provider recipe pack' "${workflow}" |
        cut -d: -f1)"
    custom_line="$(grep -n 'name: Apply custom recipe packs' "${workflow}" |
        cut -d: -f1)"
    gateway_line="$(
        grep -n 'name: Ensure routes Gateway infrastructure' "${workflow}" |
            cut -d: -f1
    )"
    app_line="$(grep -n 'name: Run rad commands' "${workflow}" | cut -d: -f1)"
    ((create_line < attach_line &&
        attach_line < custom_line &&
        custom_line < gateway_line &&
        gateway_line < app_line)) ||
        fail "${workflow}: provider recipe-pack lifecycle ordering is incorrect"

    # shellcheck disable=SC2016
    env_deploy_line="$(grep -nF 'rad deploy "$ENV_BICEP"' "${workflow}" |
        cut -d: -f1)"
    pack_deploy_line="$(
        # shellcheck disable=SC2016
        grep -nF 'rad deploy "$RECIPE_PACK_BICEP"' "${workflow}" |
            cut -d: -f1
    )"
    ((env_deploy_line < pack_deploy_line)) ||
        fail "${workflow}: recipe pack deploys before its environment"

    # shellcheck disable=SC2016
    grep -qF 'ENV_BICEP="$APP_DIR/radius-environment.bicep"' "${workflow}" ||
        fail "${workflow}: missing environment-only deployment file"
    # shellcheck disable=SC2016
    grep -qF 'RECIPE_PACK_BICEP="$APP_DIR/radius-recipe-pack.bicep"' \
        "${workflow}" ||
        fail "${workflow}: missing pack-only deployment file"
    grep -qF 'recipePacks: []' "${workflow}" ||
        fail "${workflow}: environment does not reset provider recipe packs"
    # shellcheck disable=SC2016
    grep -qF -- '--environment "$ENVIRONMENT"' "${workflow}" ||
        fail "${workflow}: pack deploy does not use the existing environment"
    grep -qF \
        'actions/attach-recipe-pack@{{RADIUS_REF}}' "${workflow}" ||
        fail "${workflow}: exact provider pack is not attached"
done

grep -qF 'recipe-pack: azure-avm' "${AZURE_WORKFLOW}" ||
    fail "Azure workflow does not attach azure-avm"
grep -qF 'recipe-pack: aws-terraform' "${AWS_WORKFLOW}" ||
    fail "AWS workflow does not attach aws-terraform"
for removed_parameter in \
    environmentName environmentNamespace azureSubscriptionId azureResourceGroup; do
    if grep -qF -- "--parameters ${removed_parameter}=" "${AZURE_WORKFLOW}"; then
        fail "Azure pack deploy still passes removed parameter ${removed_parameter}"
    fi
done

echo "provider recipe-pack lifecycle tests passed"
