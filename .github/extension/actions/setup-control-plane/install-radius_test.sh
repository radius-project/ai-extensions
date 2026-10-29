#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

mkdir -p "${TEST_ROOT}/bin" "${TEST_ROOT}/tmp"
export INSTALL_LOG="${TEST_ROOT}/install.log"
export CURL_LOG="${TEST_ROOT}/curl.log"
export INSTALLER_FIXTURE="${TEST_ROOT}/installer.sh"
export GITHUB_ENV="${TEST_ROOT}/env"
export TMPDIR="${TEST_ROOT}/tmp"
cat >"${INSTALLER_FIXTURE}" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${INSTALL_LOG}"
[[ "${FAIL_INSTALL:-}" != true ]]
BASH
cat >"${TEST_ROOT}/bin/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${FAIL_DOWNLOAD:-}" != true ]] || exit 22
printf '%s\n' "$*" >>"${CURL_LOG}"
while (($#)); do
    if [[ "$1" == "-o" ]]; then
        cp "${INSTALLER_FIXTURE}" "$2"
        exit 0
    fi
    shift
done
exit 1
BASH
cat >"${TEST_ROOT}/bin/rad" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == version ]]
[[ "${FAIL_RAD:-}" != true ]]
BASH
chmod +x "${TEST_ROOT}/bin/curl" "${TEST_ROOT}/bin/rad"
export PATH="${TEST_ROOT}/bin:${PATH}"
export RADIUS_INSTALL_REF=v1.2.3
export RADIUS_INSTALL_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RADIUS_INSTALL_SHA256="$(sha256sum "${INSTALLER_FIXTURE}" | awk '{print $1}')"
export RADIUS_INSTALL_SHA256

run_install() {
    : >"${GITHUB_ENV}"
    : >"${INSTALL_LOG}"
    : >"${CURL_LOG}"
    bash "${SCRIPT_DIR}/install-radius.sh"
}

run_install >/dev/null
grep -Fxq -- "--version v1.2.3" "${INSTALL_LOG}" ||
    fail "default install did not use the checked-in tag"
grep -Fq "/${RADIUS_INSTALL_COMMIT}/deploy/install.sh" "${CURL_LOG}" ||
    fail "default installer was not fetched by immutable commit"
grep -Fxq "RADIUS_INSTALL_COMMIT=${RADIUS_INSTALL_COMMIT}" "${GITHUB_ENV}" ||
    fail "default install did not export the catalog commit"

for tag in v1.2.4 v1.3.0-rc.1 edge; do
    export RADIUS_RELEASE_OVERRIDE
    RADIUS_RELEASE_OVERRIDE="$(jq -cn --arg tag "${tag}" --arg checksum "${RADIUS_INSTALL_SHA256}" \
        '{tag: $tag, commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", checksum: $checksum}')"
    run_install >/dev/null
    grep -Fxq -- "--version ${tag}" "${INSTALL_LOG}" ||
        fail "override did not select ${tag}"
    grep -Fq '/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/deploy/install.sh' "${CURL_LOG}" ||
        fail "override installer did not use the selected commit"
    [[ "$(RADIUS_INSTALL_COMMIT="$(sed -n 's/^RADIUS_INSTALL_COMMIT=//p' "${GITHUB_ENV}")" \
        bash "${SCRIPT_DIR}/../load-contrib-catalog/resolve-catalog-ref.sh")" == \
        bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ]] ||
        fail "catalog did not follow the installed override"
done

valid_override="${RADIUS_RELEASE_OVERRIDE}"
for value in 'not-json' null '[]' '{}' \
    "$(jq -c '.tag = "latest"' <<<"${valid_override}")" \
    "$(jq -c '.tag = "main"' <<<"${valid_override}")" \
    "$(jq -c '.tag = "Edge"' <<<"${valid_override}")" \
    "$(jq -c '.tag = "edge-1"' <<<"${valid_override}")" \
    "$(jq -c '.tag = " edge"' <<<"${valid_override}")" \
    "$(jq -c '.tag = "1.2.3"' <<<"${valid_override}")" \
    "$(jq -c '.commit = "short"' <<<"${valid_override}")" \
    "$(jq -c '.checksum = "short"' <<<"${valid_override}")" \
    "$(jq -c '.tag += "\n"' <<<"${valid_override}")" \
    "${valid_override}
${valid_override}"; do
    RADIUS_RELEASE_OVERRIDE="${value}" run_install >/dev/null 2>&1 &&
        fail "accepted malformed release metadata"
    [[ ! -s "${CURL_LOG}" && ! -s "${INSTALL_LOG}" && ! -s "${GITHUB_ENV}" ]] ||
        fail "malformed metadata reached installation"
done

RADIUS_RELEASE_OVERRIDE="$(jq -c '.checksum = ("a" * 64)' <<<"${valid_override}")" \
    run_install >/dev/null 2>&1 && fail "accepted an installer checksum mismatch"
[[ ! -s "${INSTALL_LOG}" && ! -s "${GITHUB_ENV}" ]] ||
    fail "checksum failure ran the installer or exported a catalog commit"

export RADIUS_RELEASE_OVERRIDE="${valid_override}"
for failure in FAIL_DOWNLOAD FAIL_INSTALL FAIL_RAD; do
    export "${failure}=true"
    run_install >/dev/null 2>&1 && fail "ignored ${failure}"
    unset "${failure}"
    [[ ! -s "${GITHUB_ENV}" ]] || fail "${failure} exported a catalog commit"
done
[[ -z "$(find "${TMPDIR}" -type f -print -quit)" ]] ||
    fail "installer temporary files were not removed"

echo "Radius control-plane installer tests passed"
