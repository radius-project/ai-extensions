#!/bin/bash

# Tests for resource-group.sh (the Radius resource group derivation) and for the
# action/workflow wiring that feeds it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly SCRIPT="${SCRIPT_DIR}/resource-group.sh"
readonly ACTION="${SCRIPT_DIR}/action.yml"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
readonly REPO_ROOT
readonly EXTENSION="${REPO_ROOT}/.github/extension"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

derived_for() {
    bash "${SCRIPT}" "$1" "$2"
}

# assert_derived REPOSITORY ENVIRONMENT EXPECTED
assert_derived() {
    local actual
    actual="$(derived_for "$1" "$2")"
    if [[ "${actual}" != "$3" ]]; then
        fail "derive('$1','$2') = '${actual}', expected '$3'"
    fi
}

readonly REPO="radius-project/samples"

# --- Every derived name must be a legal Radius resource name ----------------
# The server accepts `^[A-Za-z]([-A-Za-z0-9]*[A-Za-z0-9])?$` up to 63 characters,
# which is stricter than `rad group create`'s own client-side check: that one
# allows underscores and parentheses the server then rejects. So the derivation
# is asserted against the server rule, on inputs chosen to attack each clause --
# leading digit, trailing/leading separator, underscores, non-ASCII, nothing
# sluggable at all, and past the length budget.
assert_valid_name() {
    local name="$1" context="$2"
    [[ ${#name} -le 63 ]] || fail "${context}: '${name}' is ${#name} characters, over the 63 limit"
    [[ ${#name} -ge 1 ]] || fail "${context}: derived an empty name"
    if [[ ! "${name}" =~ ^[A-Za-z]([-A-Za-z0-9]*[A-Za-z0-9])?$ ]]; then
        fail "${context}: '${name}' does not match the Radius resource name pattern"
    fi
}

for environment in \
    "dev" \
    "Chatbot-env" \
    "posthog-env" \
    "prod_2" \
    "9-lives" \
    "-leading-and-trailing-" \
    "spaces and (parens)" \
    "ünïcødé" \
    "..." \
    "a-very-long-environment-name-that-comfortably-exceeds-the-fifty-character-readable-budget"; do
    assert_valid_name "$(derived_for "${REPO}" "${environment}")" "environment '${environment}'"
done

# --- The readable part stays readable ---------------------------------------
assert_derived "${REPO}" "dev" "env-dev-de35ce62"
assert_derived "${REPO}" "Chatbot-env" "env-chatbot-env-e5e1efcb"
# Nothing sluggable: the hash alone still identifies the environment.
assert_derived "${REPO}" "..." "env-63d4890d"

# --- Distinctness: what the slug cannot separate, the hash must -------------
# Case and separator normalization collapse these to one slug.
[[ "$(derived_for "${REPO}" "Chatbot-env")" != "$(derived_for "${REPO}" "chatbot env")" ]] ||
    fail "environments that differ only by case/separators must not share a group"

# The repository is in the hash, because two repositories can each name an
# environment `dev` and back both with the same cloud scope.
[[ "$(derived_for "${REPO}" "dev")" != "$(derived_for "radius-project/other" "dev")" ]] ||
    fail "the same environment name in two repositories must not share a group"

# Two long names that truncate to the same 50-character slug stay distinct,
# because the hash is taken over the untruncated input.
LONG_A="an-environment-name-long-enough-to-be-truncated-before-alpha"
LONG_B="an-environment-name-long-enough-to-be-truncated-before-beta"
[[ "$(derived_for "${REPO}" "${LONG_A}")" != "$(derived_for "${REPO}" "${LONG_B}")" ]] ||
    fail "environments whose slugs truncate identically must not share a group"

# --- Stability --------------------------------------------------------------
# A redeploy must land in the group the last deploy used. If derivation drifted,
# every run would provision replacements beside the existing resources.
[[ "$(derived_for "${REPO}" "dev")" == "$(derived_for "${REPO}" "dev")" ]] ||
    fail "derivation must be deterministic"

# --- Argument validation ----------------------------------------------------
# Deriving from a missing input would silently key every environment the same
# way, which is the collision this exists to prevent.
assert_rejects() {
    if bash "${SCRIPT}" "$@" >/dev/null 2>&1; then
        fail "expected rejection for args: $*"
    fi
}

assert_rejects
assert_rejects "${REPO}"
assert_rejects "" "dev"
assert_rejects "${REPO}" ""

# --- Wiring: the action must derive the group, never hardcode one -----------
if ! grep -q "resource-group.sh" "${ACTION}"; then
    fail "restore-state/action.yml must derive the group with resource-group.sh"
fi
if grep -qE 'rad group (create|switch) [a-z]' "${ACTION}"; then
    fail "restore-state/action.yml must not hardcode a resource group name"
fi

# Every caller must pass the repository and environment the derivation is keyed
# on; a missing input would fail the run rather than silently share a group.
for workflow in \
    "${EXTENSION}/run-rad-commands-azure.yml" \
    "${EXTENSION}/run-rad-commands-aws.yml" \
    "${EXTENSION}/delete-azure.yml" \
    "${EXTENSION}/delete-aws.yml" \
    "${EXTENSION}/delete-environment-azure.yml"; do
    [[ -f "${workflow}" ]] || fail "missing workflow: ${workflow}"
    if ! grep -q "actions/restore-state" "${workflow}"; then
        fail "$(basename "${workflow}") no longer uses the restore-state action"
    fi
    block="$(awk '/uses: .*actions\/restore-state/{found=1} found{print} found && /^$/{exit}' "${workflow}")"
    grep -q "repository:" <<<"${block}" ||
        fail "$(basename "${workflow}") must pass \`repository\` to restore-state"
    grep -q "environment:" <<<"${block}" ||
        fail "$(basename "${workflow}") must pass \`environment\` to restore-state"
done

echo "PASS: resource-group.sh"
