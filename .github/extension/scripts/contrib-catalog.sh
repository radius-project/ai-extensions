#!/usr/bin/env bash

# Generic accessors for deploy/manifest/defaults.yaml. This file is sourced by
# generated workflows after load-contrib-catalog exports RADIUS_DEFAULTS_YAML.

radius_contrib_catalog_field() {
    local section="$1" name="$2" field="$3" value

    case "${section}" in
        resourceTypes | recipePacks) ;;
        *)
            echo "ERROR: unsupported contrib catalog section '${section}'." >&2
            return 1
            ;;
    esac
    case "${field}" in
        repo | ref) ;;
        *)
            echo "ERROR: unsupported contrib catalog field '${field}'." >&2
            return 1
            ;;
    esac
    [[ "${name}" =~ ^[A-Za-z0-9._-]+$ ]] || {
        echo "ERROR: invalid contrib catalog name '${name}'." >&2
        return 1
    }
    [[ -f "${RADIUS_DEFAULTS_YAML:-}" ]] || {
        echo "ERROR: Radius defaults catalog is unavailable." >&2
        return 1
    }
    command -v yq >/dev/null 2>&1 || {
        echo "ERROR: yq is required to read the Radius defaults catalog." >&2
        return 1
    }

    if ! value="$(
        yq -e -r "
            [.${section}[] | select(.name == \"${name}\")] as \$matches |
            select(\$matches | length == 1) |
            \$matches[0].${field} |
            select(type == \"!!str\" and length > 0)
        " "${RADIUS_DEFAULTS_YAML}"
    )"; then
        echo "ERROR: expected exactly one ${section} entry '${name}' with field '${field}'." >&2
        return 1
    fi

    if [[ "${field}" == ref && ! "${value}" =~ ^[0-9a-f]{40}$ ]]; then
        echo "ERROR: ${section} entry '${name}' does not pin a lowercase commit SHA." >&2
        return 1
    fi
    if [[ "${field}" == repo && ! "${value}" =~ ^github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        echo "ERROR: ${section} entry '${name}' has unsupported repository '${value}'." >&2
        return 1
    fi
    printf '%s' "${value}"
}

radius_contrib_validate_path() {
    local path="$1"
    [[ -n "${path}" && "${path}" != /* && "${path}" != *..* && "${path}" =~ ^[A-Za-z0-9._/-]+$ ]]
}

radius_contrib_resource_git_source() {
    local resource_type="$1" recipe_path="$2" namespace repo ref resource_path
    [[ "${resource_type}" =~ ^Radius\.[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || {
        echo "ERROR: invalid Radius resource type '${resource_type}'." >&2
        return 1
    }
    radius_contrib_validate_path "${recipe_path}" || {
        echo "ERROR: invalid recipe path '${recipe_path}'." >&2
        return 1
    }

    namespace="${resource_type%%/*}"
    resource_path="${resource_type#Radius.}"
    repo="$(radius_contrib_catalog_field resourceTypes "${namespace}" repo)" || return 1
    ref="$(radius_contrib_catalog_field resourceTypes "${namespace}" ref)" || return 1
    printf 'git::https://%s.git//%s/%s?ref=%s' "${repo}" "${resource_path}" "${recipe_path}" "${ref}"
}

radius_contrib_kube_recipe_source() {
    local resource_type="$1" artifact="$2" namespace ref
    [[ "${resource_type}" =~ ^Radius\.[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || {
        echo "ERROR: invalid Radius resource type '${resource_type}'." >&2
        return 1
    }
    [[ "${artifact}" =~ ^[a-z0-9._-]+$ ]] || {
        echo "ERROR: invalid kube recipe artifact '${artifact}'." >&2
        return 1
    }

    namespace="${resource_type%%/*}"
    ref="$(radius_contrib_catalog_field resourceTypes "${namespace}" ref)" || return 1
    printf 'ghcr.io/radius-project/kube-recipes/%s:%s' "${artifact}" "${ref}"
}

radius_contrib_recipe_pack_url() {
    local pack="$1" file="$2" repo ref repo_path
    [[ "${pack}" =~ ^[A-Za-z0-9._-]+$ ]] || {
        echo "ERROR: invalid recipe pack '${pack}'." >&2
        return 1
    }
    radius_contrib_validate_path "${file}" || {
        echo "ERROR: invalid recipe pack file '${file}'." >&2
        return 1
    }

    repo="$(radius_contrib_catalog_field recipePacks "${pack}" repo)" || return 1
    ref="$(radius_contrib_catalog_field recipePacks "${pack}" ref)" || return 1
    repo_path="${repo#github.com/}"
    printf 'https://raw.githubusercontent.com/%s/%s/recipe-packs/%s/%s' \
        "${repo_path}" "${ref}" "${pack}" "${file}"
}

# Rewrites every kube recipe in a recipe pack from its mutable `latest` alias to
# the namespace commit that defaults.yaml validated, then fails if any `latest`
# kube recipe remains. Each recipe entry is keyed by its Radius resource type,
# e.g. 'Radius.Messaging/rabbitMQ': { kind: 'bicep' source: '...rabbitmq:latest' },
# so the recipes come from the pack itself rather than a hardcoded list. The label
# names the provider pack in messages.
radius_contrib_pin_kube_recipes() {
    local pack_file="$1" label="$2" pairs resource_type artifact pinned_source mutable_source pinned_file offenders grep_status

    [[ -f "${pack_file}" ]] || {
        echo "ERROR: recipe pack file '${pack_file}' does not exist." >&2
        return 1
    }

    # awk remembers the most recent resource-type key and emits it alongside each
    # kube-recipes '*:latest' source it then encounters. The quote is passed via
    # -v to keep the program single-quote free, and only 2-arg match with
    # RSTART/RLENGTH is used so it runs under mawk on the runner.
    pairs="$(awk -v q="'" '
        {
            if (match($0, q "Radius\\.[^" q "]*" q)) {
                rt = substr($0, RSTART + 1, RLENGTH - 2)
            }
            else if (match($0, /kube-recipes\/[a-z0-9._-]+:latest/)) {
                s = substr($0, RSTART, RLENGTH)
                sub(/^kube-recipes\//, "", s)
                sub(/:latest$/, "", s)
                if (rt != "") { print rt, s }
            }
        }
    ' "${pack_file}")" || {
        echo "ERROR: failed to read kube recipes from the ${label} recipe pack." >&2
        return 1
    }

    while read -r resource_type artifact; do
        [[ -n "${resource_type}" ]] || continue
        pinned_source="$(radius_contrib_kube_recipe_source "${resource_type}" "${artifact}")" || return 1
        mutable_source="${pinned_source%:*}:latest"
        if grep -Fq "source: '${pinned_source}'" "${pack_file}"; then
            continue
        fi
        if ! grep -Fq "source: '${mutable_source}'" "${pack_file}"; then
            echo "WARNING: the ${label} recipe pack has no ${resource_type} Recipe; continuing without it." >&2
            continue
        fi
        # Rewrite without `sed -i`, whose syntax differs between GNU and BSD sed.
        pinned_file="$(sed "s|${mutable_source}|${pinned_source}|g" "${pack_file}")" || return 1
        printf '%s\n' "${pinned_file}" >"${pack_file}" || return 1
        if ! grep -Fq "source: '${pinned_source}'" "${pack_file}"; then
            echo "ERROR: expected ${artifact} source was not pinned in the ${label} recipe pack." >&2
            return 1
        fi
    done <<<"${pairs}"

    # grep exits 1 when there are no matches, which is the success case here.
    # A real grep error (exit status greater than 1) still fails.
    offenders="$(grep -oE 'ghcr\.io/radius-project/kube-recipes/[a-z0-9._-]+:latest' "${pack_file}")" || {
        grep_status=$?
        if ((grep_status > 1)); then
            echo "ERROR: failed to scan ${pack_file} for unpinned kube recipes." >&2
            return "${grep_status}"
        fi
    }
    offenders="$(printf '%s' "${offenders}" | sort -u)"
    if [[ -n "${offenders}" ]]; then
        echo "ERROR: unpinned kube recipes remain in the ${label} recipe pack:" >&2
        echo "${offenders}" >&2
        echo "Each must be keyed by its 'Radius.<namespace>/<type>' resource type in the pack, with that namespace pinned in deploy/manifest/defaults.yaml, so its commit can be resolved." >&2
        return 1
    fi
}
