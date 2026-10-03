#!/usr/bin/env bash

set -euo pipefail

readonly ACTION_FILE="${ACTION_FILE:-.github/extension/actions/setup-control-plane/action.yml}"
readonly RELEASE_FILE="${RELEASE_FILE:-packages/adapter-shared/src/radius-release.ts}"
readonly RADIUS_RELEASE_API_URL="${RADIUS_RELEASE_API_URL:-https://api.github.com/repos/radius-project/radius/releases/latest}"
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
    for tool in curl jq sha256sum; do
        command -v "${tool}" >/dev/null 2>&1 ||
            fail "${tool} is required to update the Radius installer pin."
    done
}

write_output() {
    local name="$1" value="$2"
    [[ -z "${GITHUB_OUTPUT:-}" ]] || printf '%s=%s\n' "${name}" "${value}" >>"${GITHUB_OUTPUT}"
}

main() {
    require_tools
    [[ -f "${ACTION_FILE}" ]] || fail "action file not found: ${ACTION_FILE}"
    [[ -f "${RELEASE_FILE}" ]] || fail "release file not found: ${RELEASE_FILE}"

    local -a api_headers=()
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        api_headers=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    fi

    local release tag prerelease draft checksum
    release="$(curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-connrefused \
        "${api_headers[@]}" "${RADIUS_RELEASE_API_URL}")"
    tag="$(jq -er '.tag_name | select(type == "string")' <<<"${release}")" ||
        fail "latest Radius release did not include a tag."
    prerelease="$(jq -r 'if (.prerelease | type) == "boolean" then .prerelease else error("invalid prerelease") end' <<<"${release}")" ||
        fail "latest Radius release did not include prerelease metadata."
    draft="$(jq -r 'if (.draft | type) == "boolean" then .draft else error("invalid draft") end' <<<"${release}")" ||
        fail "latest Radius release did not include draft metadata."

    [[ "${prerelease}" == false && "${draft}" == false ]] ||
        fail "latest Radius release ${tag} is not stable."
    [[ "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
        fail "latest Radius release tag is not stable semver: ${tag}"

    INSTALLER_TEMP="$(mktemp)"
    ACTION_TEMP="${ACTION_FILE}.tmp"
    curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-connrefused \
        "${RADIUS_RAW_BASE_URL}/${tag}/deploy/install.sh" -o "${INSTALLER_TEMP}"
    [[ -s "${INSTALLER_TEMP}" ]] || fail "downloaded Radius installer is empty."
    checksum="$(sha256sum "${INSTALLER_TEMP}" | awk '{print $1}')"
    [[ "${checksum}" =~ ^[0-9a-f]{64}$ ]] ||
        fail "could not compute the Radius installer SHA-256 checksum."
    echo "${checksum}  ${INSTALLER_TEMP}" | sha256sum -c - >/dev/null

    [[ "$(grep -Ec '^[[:space:]]+RADIUS_INSTALL_REF: ' "${ACTION_FILE}")" -eq 1 ]] ||
        fail "${ACTION_FILE} must contain exactly one RADIUS_INSTALL_REF."
    [[ "$(grep -Ec '^[[:space:]]+RADIUS_INSTALL_SHA256: ' "${ACTION_FILE}")" -eq 1 ]] ||
        fail "${ACTION_FILE} must contain exactly one RADIUS_INSTALL_SHA256."

    [[ "$(grep -Ec "^export const RADIUS_RELEASE_TAG = \"[^\"]+\";$" "${RELEASE_FILE}")" -eq 1 ]] ||
        fail "${RELEASE_FILE} must contain exactly one RADIUS_RELEASE_TAG."

    local current_tag current_checksum current_release_tag
    current_release_tag="$(sed -nE "s/^export const RADIUS_RELEASE_TAG = \"([^\"]+)\";$/\1/p" "${RELEASE_FILE}")"
    current_tag="$(sed -nE 's/^[[:space:]]+RADIUS_INSTALL_REF: ([^[:space:]]+)$/\1/p' "${ACTION_FILE}")"
    current_checksum="$(sed -nE 's/^[[:space:]]+RADIUS_INSTALL_SHA256: ([0-9a-f]+)$/\1/p' "${ACTION_FILE}")"
    [[ -n "${current_tag}" && "${current_checksum}" =~ ^[0-9a-f]{64}$ ]] ||
        fail "${ACTION_FILE} contains malformed Radius installer pin values."

    write_output tag "${tag}"
    write_output checksum "${checksum}"
    if [[ "${current_tag}" == "${tag}" && "${current_checksum}" == "${checksum}" &&
        "${current_release_tag}" == "${tag}" ]]; then
        write_output changed false
        echo "Radius installer is already pinned to ${tag}."
        return 0
    fi

    sed -E \
        -e "s/^([[:space:]]+RADIUS_INSTALL_REF:) .*/\\1 ${tag}/" \
        -e "s/^([[:space:]]+RADIUS_INSTALL_SHA256:) .*/\\1 ${checksum}/" \
        "${ACTION_FILE}" >"${ACTION_TEMP}"
    grep -Fq "RADIUS_INSTALL_REF: ${tag}" "${ACTION_TEMP}" ||
        fail "failed to update the Radius installer release."
    grep -Fq "RADIUS_INSTALL_SHA256: ${checksum}" "${ACTION_TEMP}" ||
        fail "failed to update the Radius installer checksum."
    RELEASE_TEMP="${RELEASE_FILE}.tmp"
    sed -E "s/^(export const RADIUS_RELEASE_TAG = )\"[^\"]+\";$/\1\"${tag}\";/" \
        "${RELEASE_FILE}" >"${RELEASE_TEMP}"
    grep -Fq "export const RADIUS_RELEASE_TAG = \"${tag}\";" "${RELEASE_TEMP}" ||
        fail "failed to update the Radius release tag."
    mv "${ACTION_TEMP}" "${ACTION_FILE}"
    ACTION_TEMP=""
    mv "${RELEASE_TEMP}" "${RELEASE_FILE}"
    RELEASE_TEMP=""

    write_output changed true
    echo "Updated Radius installer pin from ${current_tag} to ${tag}."
}

main "$@"
