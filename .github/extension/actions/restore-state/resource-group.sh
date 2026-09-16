#!/bin/bash

# Derives the Radius (UCP) resource group the environment and application deploy
# into, and prints it on stdout.
#
# The group matters because a Recipe names the cloud resource it provisions from
# the Radius resource ID, and that ID is `/planes/radius/<plane>/resourcegroups/
# <group>/providers/<type>/<name>`. It carries no environment identity, so a
# fixed group makes two environments backed by the same cloud scope produce
# identical resource IDs for the same application, resolving to one shared cloud
# resource -- silently adopting each other's data and destroying it on delete.
# Keying the group to the repository and environment separates them.
#
# This is a Radius-side namespace, not an Azure resource group. It decides the ID
# Radius records a resource under; it moves nothing in the cloud.
#
# Usage: resource-group.sh <repository> <environment>
#   <repository>   `owner/repo` of the repository being deployed.
#   <environment>  Name of the GitHub deploy environment.

set -euo pipefail

# Any Radius resource name, resource groups included, must match
# `^[A-Za-z]([-A-Za-z0-9]*[A-Za-z0-9])?$` and fit in 63 characters. The fixed
# `env-` prefix guarantees the leading letter, and the 8 hex characters plus
# their separator leave 50 for the readable part.
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
# because they live in different repositories that share a cloud scope. Hashed
# from the exact untruncated inputs, so it separates what the slug cannot.
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

main() {
    local repository="${1-}" environment="${2-}" slug hash
    [[ -n "${repository}" ]] || fail "a repository is required"
    [[ -n "${environment}" ]] || fail "an environment is required"

    slug="$(slugify "${environment}")"
    slug="${slug:0:SLUG_LIMIT}"
    # Truncation can leave a trailing hyphen, which the name pattern rejects.
    slug="${slug%-}"
    hash="$(short_hash "${repository}" "${environment}")"

    # An environment named entirely outside `a-z0-9` slugs to nothing; the hash
    # alone still identifies it.
    if [[ -z "${slug}" ]]; then
        printf '%s%s' "${PREFIX}" "${hash}"
        return
    fi
    printf '%s%s-%s' "${PREFIX}" "${slug}" "${hash}"
}

main "$@"
