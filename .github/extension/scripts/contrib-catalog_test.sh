#!/usr/bin/env bash

# Tests radius_contrib_pin_kube_recipes against the pinned aws-eks and azure-aks
# pack snapshots with a synthetic defaults catalog, and checks that both
# provider workflows pin their pack through it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
readonly REPO_ROOT
readonly TESTDATA="${REPO_ROOT}/packages/core/src/modeling/testdata"
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

readonly COMPUTE_REF=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly SECURITY_REF=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
readonly MESSAGING_REF=cccccccccccccccccccccccccccccccccccccccc
readonly KUBE=ghcr.io/radius-project/kube-recipes

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# shellcheck source=.github/extension/scripts/contrib-catalog.sh
source "${SCRIPT_DIR}/contrib-catalog.sh"

write_catalog() {
    local namespace ref
    printf 'resourceTypes:\n' >"${TEST_ROOT}/defaults.yaml"
    for namespace in "$@"; do
        case "${namespace}" in
            Radius.Compute) ref="${COMPUTE_REF}" ;;
            Radius.Security) ref="${SECURITY_REF}" ;;
            Radius.Messaging) ref="${MESSAGING_REF}" ;;
        esac
        printf '  - name: %s\n    repo: github.com/radius-project/resource-types-contrib\n    ref: %s\n' \
            "${namespace}" "${ref}" >>"${TEST_ROOT}/defaults.yaml"
    done
    export RADIUS_DEFAULTS_YAML="${TEST_ROOT}/defaults.yaml"
}

# Runs the helper in an `if` so errexit is off inside it: every failure must
# come from an explicit return, as it does when a workflow tests the result.
pin() {
    local pack="$1" label="$2"
    if radius_contrib_pin_kube_recipes "${pack}" "${label}" 2>"${TEST_ROOT}/stderr"; then
        return 0
    fi
    return 1
}

assert_pinned() {
    local pack="$1" artifact="$2" ref="$3"
    grep -qF "source: '${KUBE}/${artifact}:${ref}'" "${pack}" ||
        fail "${artifact} was not pinned to ${ref} in ${pack}"
}

assert_no_latest_kube_recipe() {
    if grep -q "kube-recipes/[a-z0-9._-]*:latest" "$1"; then
        fail "a kube recipe was left on latest in $1"
    fi
}

test_pins_the_aws_pack() {
    local pack="${TEST_ROOT}/aws-eks.bicep"
    cp "${TESTDATA}/aws-eks.bicep" "${pack}"
    write_catalog Radius.Compute Radius.Security
    pin "${pack}" AWS || fail "the AWS pack was not pinned: $(cat "${TEST_ROOT}/stderr")"
    assert_no_latest_kube_recipe "${pack}"
    assert_pinned "${pack}" containers "${COMPUTE_REF}"
    assert_pinned "${pack}" routes "${COMPUTE_REF}"
    assert_pinned "${pack}" secrets "${SECURITY_REF}"
    # aws-eks recipes are pinned to the pack's commit by the AWS workflow.
    grep -qF "source: 'ghcr.io/radius-project/aws-eks-recipes/mysqldatabases:latest'" "${pack}" ||
        fail "the helper changed an aws-eks recipe"

    local before
    before="$(cat "${pack}")"
    pin "${pack}" AWS || fail "pinning an already pinned pack failed"
    [[ "$(cat "${pack}")" == "${before}" ]] || fail "pinning is not idempotent"
}

test_pins_the_azure_pack() {
    local pack="${TEST_ROOT}/azure-aks.bicep"
    cp "${TESTDATA}/azure-aks.bicep" "${pack}"
    write_catalog Radius.Compute Radius.Security Radius.Messaging
    pin "${pack}" Azure || fail "the Azure pack was not pinned: $(cat "${TEST_ROOT}/stderr")"
    assert_no_latest_kube_recipe "${pack}"
    assert_pinned "${pack}" rabbitmq "${MESSAGING_REF}"
    assert_pinned "${pack}" containers "${COMPUTE_REF}"
    assert_pinned "${pack}" secrets "${SECURITY_REF}"
}

test_leaves_a_pack_without_kube_recipes_unchanged() {
    local pack="${TEST_ROOT}/empty.bicep"
    printf "resource pack 'Radius.Core/recipePacks@2025-08-01-preview' = {}\n" >"${pack}"
    write_catalog
    pin "${pack}" AWS || fail "a pack without kube recipes was refused"
    [[ "$(cat "${pack}")" == "resource pack 'Radius.Core/recipePacks@2025-08-01-preview' = {}" ]] ||
        fail "a pack without kube recipes was changed"
}

# A namespace missing from the catalog stops pinning instead of skipping the
# recipe, even though an earlier recipe already pinned.
test_refuses_a_namespace_missing_from_the_catalog() {
    local pack="${TEST_ROOT}/aws-missing.bicep"
    cp "${TESTDATA}/aws-eks.bicep" "${pack}"
    write_catalog Radius.Compute
    pin "${pack}" AWS && fail "a recipe without a catalog commit was accepted"
    grep -qF "expected exactly one resourceTypes entry 'Radius.Security'" "${TEST_ROOT}/stderr" ||
        fail "the missing namespace was not named"
    if grep -qE "WARNING|unpinned kube recipes remain" "${TEST_ROOT}/stderr"; then
        fail "pinning continued after the catalog lookup failed"
    fi
    grep -qF "${KUBE}/secrets:latest" "${pack}" ||
        fail "the unresolved recipe was rewritten"
}

test_refuses_an_unkeyed_latest_recipe() {
    local label="$1" pack="${TEST_ROOT}/unkeyed.bicep"
    printf "recipes: {\n  source: '%s/orphan:latest'\n}\n" "${KUBE}" >"${pack}"
    write_catalog
    pin "${pack}" "${label}" && fail "an unkeyed latest recipe was accepted"
    grep -qF "unpinned kube recipes remain in the ${label} recipe pack" "${TEST_ROOT}/stderr" ||
        fail "the refusal did not name the ${label} pack"
    grep -qxF "${KUBE}/orphan:latest" "${TEST_ROOT}/stderr" ||
        fail "the refusal did not list the unpinned recipe"
}

# A keyed recipe that is not a `source:` value cannot be rewritten in place, so
# it warns and then fails the remaining-latest scan.
test_refuses_a_recipe_outside_a_source_field() {
    local pack="${TEST_ROOT}/image.bicep"
    printf "'Radius.Compute/containers': {\n  image: '%s/containers:latest'\n}\n" "${KUBE}" >"${pack}"
    write_catalog Radius.Compute
    pin "${pack}" Azure && fail "a recipe outside a source field was accepted"
    grep -qF "WARNING: the Azure recipe pack has no Radius.Compute/containers Recipe" "${TEST_ROOT}/stderr" ||
        fail "the unmatched recipe did not warn"
    grep -qF "unpinned kube recipes remain in the Azure recipe pack" "${TEST_ROOT}/stderr" ||
        fail "the unmatched recipe did not fail the scan"
}

test_refuses_a_missing_pack() {
    pin "${TEST_ROOT}/absent.bicep" AWS && fail "a missing pack was accepted"
    grep -qF "recipe pack file '${TEST_ROOT}/absent.bicep' does not exist" "${TEST_ROOT}/stderr" ||
        fail "the missing pack was not named"
}

test_both_workflows_use_the_helper() {
    local provider workflow
    for provider in aws:AWS azure:Azure; do
        workflow="${REPO_ROOT}/.github/extension/run-rad-commands-${provider%%:*}.yml"
        # shellcheck disable=SC2016
        [[ "$(grep -cF "radius_contrib_pin_kube_recipes \"\$RECIPE_PACK_BICEP\" ${provider#*:}" "${workflow}")" == 1 ]] ||
            fail "${workflow} does not pin its pack with the shared helper"
        if grep -qE 'pin_kube_recipe\(\)|kube-recipes/\[a-z0-9' "${workflow}"; then
            fail "${workflow} still has its own kube recipe pinning"
        fi
    done
}

test_pins_the_aws_pack
test_pins_the_azure_pack
test_leaves_a_pack_without_kube_recipes_unchanged
test_refuses_a_namespace_missing_from_the_catalog
test_refuses_an_unkeyed_latest_recipe AWS
test_refuses_an_unkeyed_latest_recipe Azure
test_refuses_a_recipe_outside_a_source_field
test_refuses_a_missing_pack
test_both_workflows_use_the_helper

echo "Contrib catalog helper tests passed"
