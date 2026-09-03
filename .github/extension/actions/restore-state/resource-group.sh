#!/bin/bash

# Chooses the Radius (UCP) resource group the environment and application deploy
# into, and prints it on stdout.
#
# The group matters because a Recipe names the cloud resource it provisions from
# the Radius resource ID, and that ID is `/planes/radius/<plane>/resourcegroups/
# <group>/providers/<type>/<name>`. It carries no environment identity, so while
# every deploy used the group `default`, two environments backed by the same
# Azure scope produced identical resource IDs for the same application and
# resolved to one shared cloud resource -- silently adopting each other's data
# and destroying it on delete. A group derived from the repository and the
# environment separates them.
#
# Usage: resource-group.sh <repository> <environment> <list-status>
#   <repository>   `owner/repo` of the repository being deployed.
#   <environment>  Name of the GitHub deploy environment.
#   <list-status>  `ok` when `rad group list -o json` succeeded, anything else
#                  when it did not.
#   stdin          That command's stdout, read only when <list-status> is `ok`.
#
# Run it directly after `rad startup` and before any `rad deploy`, because
# `rad deploy` itself creates a `default` group to hold the built-in recipe pack
# (radius-project/radius `recipepack.EnsureDefaultResourceGroup`). Reading the
# group list later would no longer show what the restore produced.

set -euo pipefail

readonly LEGACY_GROUP="default"
# The server accepts `^[A-Za-z]([-A-Za-z0-9]*[A-Za-z0-9])?$` up to 63 characters
# for any Radius resource name, resource groups included, so the fixed `env-`
# prefix guarantees the leading letter and the 8 hex characters and their
# separator leave 50 for the readable part.
readonly PREFIX="env-"
readonly HASH_LENGTH=8
readonly SLUG_LIMIT=50

fail() {
    echo "resource-group.sh: $*" >&2
    exit 1
}

# Lowercases, replaces every character outside `a-z0-9` with a hyphen, collapses
# runs, and trims the ends, so the result cannot start or end with a hyphen.
slugify() {
    printf '%s' "$1" |
        tr '[:upper:]' '[:lower:]' |
        tr -c 'a-z0-9' '-' |
        sed -E 's/-+/-/g; s/^-//; s/-$//'
}

# Distinguishes two environments whose slugs collide -- after truncation, or
# because they live in different repositories that share an Azure scope. Hashed
# from the exact untruncated inputs, so it distinguishes what the slug cannot.
short_hash() {
    local digest
    if command -v sha256sum >/dev/null 2>&1; then
        digest="$(printf '%s\n%s' "$1" "$2" | sha256sum)"
    elif command -v shasum >/dev/null 2>&1; then
        digest="$(printf '%s\n%s' "$1" "$2" | shasum -a 256)"
    else
        fail "no sha256sum or shasum available to derive a resource group name"
    fi
    printf '%s' "${digest:0:HASH_LENGTH}"
}

derive_group() {
    local repository="$1" environment="$2" slug hash
    slug="$(slugify "${environment}")"
    slug="${slug:0:SLUG_LIMIT}"
    # Truncation can leave a trailing hyphen, which the name pattern rejects.
    slug="${slug%-}"
    hash="$(short_hash "${repository}" "${environment}")"
    if [[ -z "${slug}" ]]; then
        printf '%s%s' "${PREFIX}" "${hash}"
        return
    fi
    printf '%s%s-%s' "${PREFIX}" "${slug}" "${hash}"
}

main() {
    local repository="${1-}" environment="${2-}" list_status="${3-}"
    [[ -n "${repository}" ]] || fail "a repository is required"
    [[ -n "${environment}" ]] || fail "an environment is required"

    local derived
    derived="$(derive_group "${repository}" "${environment}")"

    # Fail closed to the legacy group. Choosing the derived group without
    # knowing what the restore produced would strand an existing environment's
    # resources in a group nothing deploys to or deletes from, and provision
    # empty replacements beside them.
    if [[ "${list_status}" != "ok" ]]; then
        printf '%s' "${LEGACY_GROUP}"
        return
    fi

    local names raw
    raw="$(cat)"
    # Empty output cannot be told apart from `[]` by a parser, and reading it as
    # "the restore produced no groups" would move an existing environment.
    if [[ -z "${raw//[[:space:]]/}" ]]; then
        printf '%s' "${LEGACY_GROUP}"
        return
    fi
    # Anything that is not a list of named groups is an answer this cannot read:
    # a friendly error the CLI prints on stdout, or an entry with no name. An
    # empty list is not that -- it is the readable answer "nothing restored".
    if ! names="$(printf '%s' "${raw}" |
        jq -r 'if type == "array" then map(.name) | if all(type == "string") then .[] else error end else error end' 2>/dev/null)"; then
        printf '%s' "${LEGACY_GROUP}"
        return
    fi

    # Already migrated, or created after this change: its resources are in the
    # derived group, so keep using it even though `default` also exists by now.
    if grep -qxF "${derived}" <<<"${names}"; then
        printf '%s' "${derived}"
        return
    fi

    # An environment deployed before this change holds its resources in
    # `default`. Moving it would orphan them and provision empty replacements,
    # so it stays where it is until it is recreated.
    if grep -qxF "${LEGACY_GROUP}" <<<"${names}"; then
        printf '%s' "${LEGACY_GROUP}"
        return
    fi

    # Nothing restored: this environment has never been deployed.
    printf '%s' "${derived}"
}

main "$@"
