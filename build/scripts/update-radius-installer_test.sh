#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly UPDATER="${SCRIPT_DIR}/update-radius-installer.sh"
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/bin/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${FAIL_CURL:-}" != true ]] || exit 22
output=""
url=""
while (($#)); do
    case "$1" in
        -o)
            output="$2"
            shift 2
            ;;
        http*)
            url="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done
[[ -n "${url}" ]]
printf '%s\n' "${url}" >>"${CURL_LOG}"
if [[ "${url}" == */releases/latest ]]; then
    printf '%s\n' "${RELEASE_JSON}"
else
    [[ "${FAIL_INSTALLER_CURL:-}" != true ]] || exit 22
    [[ -n "${output}" ]]
    cp "${INSTALLER_FIXTURE}" "${output}"
fi
BASH
chmod +x "${TEST_ROOT}/bin/curl"

write_action() {
    local ref="$1" checksum="$2"
    cat >"${ACTION_FILE}" <<YAML
---
name: test
runs:
  using: composite
  steps:
    - shell: bash
      env:
        RADIUS_INSTALL_REF: ${ref}
        RADIUS_INSTALL_SHA256: ${checksum}
      run: /bin/bash install-rad.sh edge
YAML
}

run_update() {
    : >"${GITHUB_OUTPUT}"
    PATH="${TEST_ROOT}/bin:${PATH}" bash "${UPDATER}"
}

export ACTION_FILE="${TEST_ROOT}/action.yml"
export CURL_LOG="${TEST_ROOT}/curl.log"
export GITHUB_OUTPUT="${TEST_ROOT}/output"
export INSTALLER_FIXTURE="${TEST_ROOT}/install.sh"
export RADIUS_RELEASE_API_URL="https://example.test/releases/latest"
export RADIUS_RAW_BASE_URL="https://example.test/radius"
export RELEASE_JSON='{"tag_name":"v1.2.3","prerelease":false,"draft":false}'
printf '#!/usr/bin/env bash\necho Radius\n' >"${INSTALLER_FIXTURE}"
EXPECTED_CHECKSUM="$(sha256sum "${INSTALLER_FIXTURE}" | awk '{print $1}')"
readonly EXPECTED_CHECKSUM
readonly OLD_CHECKSUM="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

write_action v1.2.2 "${OLD_CHECKSUM}"
run_update >/dev/null
grep -Fq "RADIUS_INSTALL_REF: v1.2.3" "${ACTION_FILE}" ||
    fail "updater did not replace the stable release tag"
grep -Fq "RADIUS_INSTALL_SHA256: ${EXPECTED_CHECKSUM}" "${ACTION_FILE}" ||
    fail "updater did not replace the installer checksum"
grep -Fxq "changed=true" "${GITHUB_OUTPUT}" ||
    fail "updater did not report a change"
grep -Fxq "https://example.test/radius/v1.2.3/deploy/install.sh" "${CURL_LOG}" ||
    fail "updater fetched the installer from the wrong release"
grep -Fq "/bin/bash install-rad.sh edge" "${ACTION_FILE}" ||
    fail "updater changed the edge CLI channel"

cp "${ACTION_FILE}" "${TEST_ROOT}/before.yml"
run_update >/dev/null
cmp -s "${TEST_ROOT}/before.yml" "${ACTION_FILE}" ||
    fail "updater rewrote an already-current action"
grep -Fxq "changed=false" "${GITHUB_OUTPUT}" ||
    fail "updater did not report the no-op"

write_action v1.2.2 "${OLD_CHECKSUM}"
printf '        RADIUS_INSTALL_REF: v1.2.1\n' >>"${ACTION_FILE}"
cp "${ACTION_FILE}" "${TEST_ROOT}/malformed.yml"
if run_update >/dev/null 2>&1; then
    fail "updater accepted duplicate release pins"
fi
cmp -s "${TEST_ROOT}/malformed.yml" "${ACTION_FILE}" ||
    fail "updater partially changed malformed input"

write_action v1.2.2 "${OLD_CHECKSUM}"
export RELEASE_JSON='{"tag_name":"v1.3.0-rc.1","prerelease":true,"draft":false}'
if run_update >/dev/null 2>&1; then
    fail "updater accepted a prerelease"
fi
grep -Fq "RADIUS_INSTALL_REF: v1.2.2" "${ACTION_FILE}" ||
    fail "prerelease failure changed the action"

export RELEASE_JSON='{"tag_name":"v1.3.0","prerelease":false,"draft":true}'
if run_update >/dev/null 2>&1; then
    fail "updater accepted a draft release"
fi

export RELEASE_JSON='{"tag_name":"v1.2.3","prerelease":false,"draft":false}'
export FAIL_INSTALLER_CURL=true
if run_update >/dev/null 2>&1; then
    fail "updater ignored an installer fetch failure"
fi
unset FAIL_INSTALLER_CURL

export FAIL_CURL=true
if run_update >/dev/null 2>&1; then
    fail "updater ignored a release API failure"
fi

echo "Radius installer updater tests passed"
