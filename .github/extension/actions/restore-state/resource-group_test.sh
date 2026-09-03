#!/bin/bash

# Tests for resource-group.sh (the Radius resource group selector) and for the
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

# assert_group REPOSITORY ENVIRONMENT STATUS GROUPS_JSON EXPECTED
assert_group() {
    local repository="$1" environment="$2" status="$3" groups="$4" expected="$5"
    local actual
    actual="$(printf '%s' "${groups}" | bash "${SCRIPT}" "${repository}" "${environment}" "${status}")"
    if [[ "${actual}" != "${expected}" ]]; then
        fail "select('${repository}','${environment}','${status}') = '${actual}', expected '${expected}'"
    fi
}

# assert_derived REPOSITORY ENVIRONMENT EXPECTED -- the name chosen when the
# restore produced no groups at all.
assert_derived() {
    assert_group "$1" "$2" "ok" "[]" "$3"
}

derived_for() {
    printf '%s' "[]" | bash "${SCRIPT}" "$1" "$2" "ok"
}

readonly REPO="radius-project/samples"
readonly LEGACY="default"

# --- Derivation: shape, charset, and stability ------------------------------
# The server accepts `^[A-Za-z]([-A-Za-z0-9]*[A-Za-z0-9])?$` up to 63 characters
# for any Radius resource name, so every derived name must satisfy it.
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
    name="$(derived_for "${REPO}" "${environment}")"
    assert_valid_name "${name}" "environment '${environment}'"
done

# A name with nothing sluggable still derives a valid, non-empty group.
assert_derived "${REPO}" "..." "env-63d4890d"

# Readable names keep the environment visible.
assert_derived "${REPO}" "dev" "env-dev-de35ce62"
assert_derived "${REPO}" "Chatbot-env" "env-chatbot-env-e5e1efcb"
# Case and separator normalization collapse to the same slug, and the hash of
# the exact input is what keeps the two groups apart.
[[ "$(derived_for "${REPO}" "Chatbot-env")" != "$(derived_for "${REPO}" "chatbot env")" ]] ||
    fail "environments that differ only by case/separators must not share a group"

# Derivation is stable: the same inputs must produce the same group on every run,
# or a redeploy would provision replacements beside the existing resources.
[[ "$(derived_for "${REPO}" "dev")" == "$(derived_for "${REPO}" "dev")" ]] ||
    fail "derivation must be deterministic"

# The repository is part of the hash, because two repositories can name an
# environment `dev` and back it with the same Azure scope.
[[ "$(derived_for "${REPO}" "dev")" != "$(derived_for "radius-project/other" "dev")" ]] ||
    fail "the same environment name in two repositories must not share a group"

# Two long environment names that truncate to the same slug stay distinct.
LONG_A="an-environment-name-long-enough-to-be-truncated-before-alpha"
LONG_B="an-environment-name-long-enough-to-be-truncated-before-beta"
[[ "$(derived_for "${REPO}" "${LONG_A}")" != "$(derived_for "${REPO}" "${LONG_B}")" ]] ||
    fail "environments whose slugs truncate identically must not share a group"

# --- Selection: which group an actual run uses ------------------------------
DEV_GROUP="$(derived_for "${REPO}" "dev")"
readonly DEV_GROUP

# 1. A fresh environment: `rad startup` restored nothing, so use the derived
#    group. This is the only case that changes behavior for a new environment.
assert_group "${REPO}" "dev" "ok" "[]" "${DEV_GROUP}"

# 2. An environment deployed before this change keeps its resources where they
#    are. Moving it would orphan them and provision empty replacements.
assert_group "${REPO}" "dev" "ok" '[{"name":"default"}]' "${LEGACY}"

# 3. Second and later runs of a migrated environment. `rad deploy` creates
#    `default` for the built-in recipe pack, so `default` is present here too --
#    the derived group must still win, or every environment would drift back.
assert_group "${REPO}" "dev" "ok" \
    "[{\"name\":\"default\"},{\"name\":\"${DEV_GROUP}\"}]" "${DEV_GROUP}"
# Order in the listing must not decide it.
assert_group "${REPO}" "dev" "ok" \
    "[{\"name\":\"${DEV_GROUP}\"},{\"name\":\"default\"}]" "${DEV_GROUP}"

# 4. Another environment's group in the listing is not this environment's.
assert_group "${REPO}" "dev" "ok" \
    "[{\"name\":\"$(derived_for "${REPO}" "prod")\"}]" "${DEV_GROUP}"

# --- Selection: failing closed ----------------------------------------------
# Every unusable answer resolves to `default`, never to the derived group:
# guessing wrong for an existing environment strands its resources, while
# guessing wrong for a new one only leaves the pre-existing collision in place.
assert_group "${REPO}" "dev" "failed" "" "${LEGACY}"
assert_group "${REPO}" "dev" "" "" "${LEGACY}"
assert_group "${REPO}" "dev" "ok" "not json" "${LEGACY}"
assert_group "${REPO}" "dev" "ok" "" "${LEGACY}"
assert_group "${REPO}" "dev" "ok" '{"error":"unauthorized"}' "${LEGACY}"
# A listing whose entries carry no name is an answer this cannot read.
assert_group "${REPO}" "dev" "ok" '[{"id":"/planes/radius/local/resourcegroups/default"}]' "${LEGACY}"
# An empty list is readable, and it means the restore produced nothing.
assert_group "${REPO}" "dev" "ok" "[]" "${DEV_GROUP}"

# --- Argument validation ----------------------------------------------------
assert_rejects() {
    if printf '%s' "[]" | bash "${SCRIPT}" "$@" >/dev/null 2>&1; then
        fail "expected rejection for args: $*"
    fi
}

assert_rejects
assert_rejects "${REPO}"
assert_rejects "" "dev" "ok"
assert_rejects "${REPO}" "" "ok"

# --- Wiring: the action must use the script, not a literal group ------------
if ! grep -q "resource-group.sh" "${ACTION}"; then
    fail "restore-state/action.yml must select the group with resource-group.sh"
fi
if grep -qE 'rad group (create|switch) default' "${ACTION}"; then
    fail "restore-state/action.yml must not hardcode the \`default\` group"
fi
if ! grep -q 'rad group list -o json' "${ACTION}"; then
    fail "restore-state/action.yml must read the restored groups with \`rad group list -o json\`"
fi

# Every caller must pass the repository and environment the selection is keyed
# on; a missing input would silently fall back to a different group.
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
