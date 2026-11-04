#!/usr/bin/env bash

set -euo pipefail

readonly ACTION_FILE="${ACTION_FILE:-.github/extension/actions/setup-control-plane/action.yml}"
readonly RELEASE_FILE="${RELEASE_FILE:-packages/adapter-shared/src/radius-release.json}"
readonly RADIUS_RELEASE_API_URL="${RADIUS_RELEASE_API_URL:-https://api.github.com/repos/radius-project/radius/releases/latest}"
readonly RADIUS_COMMIT_API_URL="${RADIUS_COMMIT_API_URL:-https://api.github.com/repos/radius-project/radius/commits}"
readonly RADIUS_RAW_BASE_URL="${RADIUS_RAW_BASE_URL:-https://raw.githubusercontent.com/radius-project/radius}"
INSTALLER_TEMP=""
ACTION_TEMP=""
RELEASE_TEMP=""

cleanup() {
    [[ -z "${INSTALLER_TEMP}" ]] || rm -f "${INSTALLER_TEMP}"
    [[ -z "${ACTION_TEMP}" ]] || rm -f "${ACTION_TEMP}"
    [[ -z "${RELEASE_TEMP}" ]] || rm -f "${RELEASE_TEMP}"
}
trap cleanup EXIT

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

require_tools() {
    local tool
    for tool in curl jq sha256sum tr; do
        command -v "${tool}" >/dev/null 2>&1 ||
            fail "${tool} is required to update the Radius installer pin."
    done
}

jq_lf() {
    # Native Windows jq writes CRLF; shell values and generated files need LF.
    jq "$@" | tr -d '\r'
}

write_output() {
    local name="$1" value="$2"
    [[ -z "${GITHUB_OUTPUT:-}" ]] || printf '%s=%s\n' "${name}" "${value}" >>"${GITHUB_OUTPUT}"
}

main() {
    local requested_tag=""
    if (($#)); then
        [[ $# -eq 2 && "$1" == "--version" ]] ||
            fail "usage: update-radius-installer.sh [--version vX.Y.Z[-rc.N]]"
        requested_tag="$2"
        [[ "${requested_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] ||
            fail "invalid Radius release tag: ${requested_tag}"
    fi
    require_tools
    [[ -f "${ACTION_FILE}" ]] || fail "action file not found: ${ACTION_FILE}"
    [[ -f "${RELEASE_FILE}" ]] || fail "release file not found: ${RELEASE_FILE}"

    local -a api_headers=()
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        api_headers=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    fi

    local release tag prerelease draft checksum release_url
    release_url="${RADIUS_RELEASE_API_URL}"
    if [[ -n "${requested_tag}" ]]; then
        release_url="${RADIUS_RELEASE_API_URL%/latest}/tags/${requested_tag}"
    fi
    release="$(curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-connrefused \
        "${api_headers[@]}" "${release_url}")"
    tag="$(jq_lf -er '.tag_name | select(type == "string")' <<<"${release}")" ||
        fail "latest Radius release did not include a tag."
    prerelease="$(jq_lf -r 'if (.prerelease | type) == "boolean" then .prerelease else error("invalid prerelease") end' <<<"${release}")" ||
        fail "latest Radius release did not include prerelease metadata."
    draft="$(jq_lf -r 'if (.draft | type) == "boolean" then .draft else error("invalid draft") end' <<<"${release}")" ||
        fail "latest Radius release did not include draft metadata."

    [[ "${draft}" == false ]] || fail "Radius release ${tag} is a draft."
    if [[ -n "${requested_tag}" ]]; then
        [[ "${tag}" == "${requested_tag}" ]] ||
            fail "requested Radius release ${requested_tag}, but the API returned ${tag}."
    else
        [[ "${prerelease}" == false ]] ||
            fail "latest Radius release ${tag} is not stable."
        [[ "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
            fail "latest Radius release tag is not stable semver: ${tag}"
    fi

    local commit
    commit="$(curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-connrefused \
        "${api_headers[@]}" -H "Accept: application/vnd.github.sha" \
        "${RADIUS_COMMIT_API_URL}/${tag}")"
    [[ "${commit}" =~ ^[0-9a-f]{40}$ ]] ||
        fail "could not resolve the commit for Radius release ${tag}."

    INSTALLER_TEMP="$(mktemp)"
    ACTION_TEMP="${ACTION_FILE}.tmp"
    curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-connrefused \
        "${RADIUS_RAW_BASE_URL}/${commit}/deploy/install.sh" -o "${INSTALLER_TEMP}"
    [[ -s "${INSTALLER_TEMP}" ]] || fail "downloaded Radius installer is empty."
    checksum="$(sha256sum "${INSTALLER_TEMP}" | awk '{print $1}')"
    [[ "${checksum}" =~ ^[0-9a-f]{64}$ ]] ||
        fail "could not compute the Radius installer SHA-256 checksum."
    echo "${checksum}  ${INSTALLER_TEMP}" | sha256sum -c - >/dev/null

    [[ "$(grep -Ec '^[[:space:]]+RADIUS_INSTALL_REF: ' "${ACTION_FILE}")" -eq 1 ]] ||
        fail "${ACTION_FILE} must contain exactly one RADIUS_INSTALL_REF."
    [[ "$(grep -Ec '^[[:space:]]+RADIUS_INSTALL_SHA256: ' "${ACTION_FILE}")" -eq 1 ]] ||
        fail "${ACTION_FILE} must contain exactly one RADIUS_INSTALL_SHA256."

    jq -e '(.tag | type == "string") and (.commit | type == "string")' "${RELEASE_FILE}" >/dev/null 2>&1 ||
        fail "${RELEASE_FILE} must be a JSON object with string tag and commit."

    [[ "$(grep -Ec '^[[:space:]]+RADIUS_INSTALL_COMMIT: ' "${ACTION_FILE}")" -eq 1 ]] ||
        fail "${ACTION_FILE} must contain exactly one RADIUS_INSTALL_COMMIT."

    local current_tag current_checksum current_release_tag current_release_commit current_commit
    current_release_tag="$(jq_lf -r .tag "${RELEASE_FILE}")"
    current_release_commit="$(jq_lf -r .commit "${RELEASE_FILE}")"
    current_tag="$(sed -nE 's/^[[:space:]]+RADIUS_INSTALL_REF: ([^[:space:]]+)$/\1/p' "${ACTION_FILE}")"
    current_commit="$(sed -nE 's/^[[:space:]]+RADIUS_INSTALL_COMMIT: ([0-9a-f]{40})$/\1/p' "${ACTION_FILE}")"
    current_checksum="$(sed -nE 's/^[[:space:]]+RADIUS_INSTALL_SHA256: ([0-9a-f]+)$/\1/p' "${ACTION_FILE}")"
    [[ -n "${current_tag}" && "${current_checksum}" =~ ^[0-9a-f]{64}$ ]] ||
        fail "${ACTION_FILE} contains malformed Radius installer pin values."

    write_output tag "${tag}"
    write_output checksum "${checksum}"
    write_output commit "${commit}"
    local release_override
    # shellcheck disable=SC2016 # These variables belong to jq, not the shell.
    release_override="$(jq_lf -cn --arg tag "${tag}" --arg commit "${commit}" \
        --arg checksum "${checksum}" '{tag: $tag, commit: $commit, checksum: $checksum}')"
    write_output release "${release_override}"
    if [[ "${current_tag}" == "${tag}" && "${current_checksum}" == "${checksum}" &&
        "${current_release_tag}" == "${tag}" && "${current_release_commit}" == "${commit}" && "${current_commit}" == "${commit}" ]]; then
        write_output changed false
        echo "Radius installer is already pinned to ${tag}."
        return 0
    fi

    sed -E \
        -e "s/^([[:space:]]+RADIUS_INSTALL_REF:) .*/\\1 ${tag}/" \
        -e "s/^([[:space:]]+RADIUS_INSTALL_SHA256:) .*/\\1 ${checksum}/" \
        -e "s/^([[:space:]]+RADIUS_INSTALL_COMMIT:) .*/\\1 ${commit}/" \
        "${ACTION_FILE}" >"${ACTION_TEMP}"
    grep -Fq "RADIUS_INSTALL_REF: ${tag}" "${ACTION_TEMP}" ||
        fail "failed to update the Radius installer release."
    grep -Fq "RADIUS_INSTALL_SHA256: ${checksum}" "${ACTION_TEMP}" ||
        fail "failed to update the Radius installer checksum."
    grep -Fq "RADIUS_INSTALL_COMMIT: ${commit}" "${ACTION_TEMP}" ||
        fail "failed to update the Radius release commit."
    RELEASE_TEMP="${RELEASE_FILE}.tmp"
    # shellcheck disable=SC2016 # These variables belong to jq, not the shell.
    jq_lf --arg tag "${tag}" --arg commit "${commit}" '.tag = $tag | .commit = $commit' \
        "${RELEASE_FILE}" >"${RELEASE_TEMP}"
    [[ "$(jq_lf -r '.tag + " " + .commit' "${RELEASE_TEMP}")" == "${tag} ${commit}" ]] ||
        fail "failed to update the Radius release tag."
    mv "${ACTION_TEMP}" "${ACTION_FILE}"
    ACTION_TEMP=""
    mv "${RELEASE_TEMP}" "${RELEASE_FILE}"
    RELEASE_TEMP=""

    write_output changed true
    echo "Updated Radius installer pin from ${current_tag} to ${tag}."
}

main "$@"
