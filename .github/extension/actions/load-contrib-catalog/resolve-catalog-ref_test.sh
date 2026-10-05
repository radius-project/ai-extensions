#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly RESOLVER="${SCRIPT_DIR}/resolve-catalog-ref.sh"
readonly ACTION_YML="${SCRIPT_DIR}/action.yml"
readonly CONTROL_PLANE_YML="${SCRIPT_DIR}/../setup-control-plane/action.yml"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

write_control_plane() {
    printf '%s\n' "$@" >"${TEST_ROOT}/action.yml"
}

# A valid pin is read from the control-plane action.
write_control_plane 'runs:' '  steps:' '    - env:' '        RADIUS_INSTALL_REF: v1.2.3' '        RADIUS_INSTALL_COMMIT: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' '      run: echo ok'
[[ "$(bash "${RESOLVER}" "" "${TEST_ROOT}/action.yml")" == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]] ||
    fail "resolver did not read RADIUS_INSTALL_COMMIT from the control-plane action"

# An explicit ref overrides the pin.
[[ "$(bash "${RESOLVER}" "abc123" "${TEST_ROOT}/action.yml")" == "abc123" ]] ||
    fail "resolver ignored an explicit catalog ref"

# A missing or malformed pin fails instead of fetching an unintended ref.
write_control_plane 'runs:' '  steps:' '    - run: echo ok'
if bash "${RESOLVER}" "" "${TEST_ROOT}/action.yml" >/dev/null 2>&1; then
    fail "resolver accepted a control-plane action without RADIUS_INSTALL_COMMIT"
fi
write_control_plane 'runs:' '  steps:' '    - env:' '        RADIUS_INSTALL_COMMIT:' '      run: echo ok'
if bash "${RESOLVER}" "" "${TEST_ROOT}/action.yml" >/dev/null 2>&1; then
    fail "resolver accepted an empty RADIUS_INSTALL_COMMIT"
fi
if bash "${RESOLVER}" "" "${TEST_ROOT}/missing.yml" >/dev/null 2>&1; then
    fail "resolver accepted a missing control-plane action"
fi

# The shipped action derives its default through this resolver, and the real
# sibling control-plane action carries a pin the resolver can read.
grep -Fq 'resolve-catalog-ref.sh' "${ACTION_YML}" ||
    fail "load-contrib-catalog does not call resolve-catalog-ref.sh"
[[ "$(bash "${RESOLVER}" "")" == "$(sed -nE 's/^[[:space:]]+RADIUS_INSTALL_COMMIT: ([^[:space:]]+)$/\1/p' "${CONTROL_PLANE_YML}")" ]] ||
    fail "resolver did not match the shipped control-plane pin"

echo "resolve-catalog-ref tests passed"
