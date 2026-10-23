#!/bin/bash

# ============================================================================
# Behavior tests for `build/scripts/cloud-e2e-cleanup-lib.sh`.
#
# `gh`, `kubectl` and `sleep` are replaced by shell functions, so the tests
# need no network, no cluster and no wait. Each case runs in a subshell, so a
# helper that calls `exit` stops only that case.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

# shellcheck source=build/scripts/cloud-e2e-cleanup-lib.sh
source "${SCRIPT_DIR}/cloud-e2e-cleanup-lib.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "ok - $*"
}

assert_eq() {
    local actual="$1" expected="$2" label="$3"
    [[ "${actual}" == "${expected}" ]] ||
        fail "${label}: expected '${expected}', got '${actual}'"
}

assert_contains() {
    local haystack="$1" needle="$2" label="$3"
    case "${haystack}" in
    *"${needle}"*) ;;
    *) fail "${label}: expected to find '${needle}' in:
${haystack}" ;;
    esac
}

# Runs a command and prints its exit status, so a non-zero status does not
# stop the test under `set -e`.
status_of() {
    local status=0
    "$@" >/dev/null 2>&1 || status=$?
    echo "${status}"
}

write_stderr() {
    local file="${TEST_ROOT}/stderr"
    printf '%s\n' "$1" >"${file}"
    echo "${file}"
}

sleep() { :; }

# ---------------------------------------------------------------------------
# HTTP status parsing and classification
# ---------------------------------------------------------------------------

file="$(write_stderr $'gh: Not Found (HTTP 404)\ngh: Validation Failed (HTTP 422)')"
assert_eq "$(cleanup_http_status "${file}")" "422" "last status wins"
file="$(write_stderr "dial tcp: connection reset")"
assert_eq "$(cleanup_http_status "${file}")" "" "no status"
pass "cleanup_http_status reads the last HTTP status"

for status in 400 401 403 405 409 410 422; do
    assert_eq "$(status_of cleanup_is_terminal_http_status "${status}")" "0" \
        "HTTP ${status} is terminal"
done
for status in 404 429 500 502 503; do
    assert_eq "$(status_of cleanup_is_terminal_http_status "${status}")" "1" \
        "HTTP ${status} is not terminal"
done
pass "cleanup_is_terminal_http_status classifies statuses"

file="$(write_stderr "gh: Resource not accessible by integration (HTTP 403)")"
assert_eq "$(status_of cleanup_is_terminal_gh_error "${file}")" "0" \
    "403 permission error"
file="$(write_stderr "gh: You have exceeded a secondary rate limit (HTTP 403)")"
assert_eq "$(status_of cleanup_is_terminal_gh_error "${file}")" "1" \
    "403 rate limit"
file="$(write_stderr "gh: Server Error (HTTP 502)")"
assert_eq "$(status_of cleanup_is_terminal_gh_error "${file}")" "1" \
    "502 server error"
pass "cleanup_is_terminal_gh_error lets a rate limit retry"

# ---------------------------------------------------------------------------
# cleanup_fail_if_terminal
# ---------------------------------------------------------------------------

file="$(write_stderr "gh: Server Error (HTTP 500)")"
output="$(cleanup_fail_if_terminal "${file}" "Delete x" 2>&1)" ||
    fail "a transient error must not stop the step"
assert_eq "${output}" "" "a transient error prints nothing"

file="$(write_stderr "gh: Workflow does not have 'workflow_dispatch' trigger (HTTP 422)")"
status=0
output="$( (cleanup_fail_if_terminal "${file}" "Dispatch delete" "Run it by hand.") 2>&1)" ||
    status=$?
assert_eq "${status}" "1" "a terminal error exits 1"
assert_contains "${output}" "::error::Dispatch delete failed with HTTP 422" \
    "terminal error message"
assert_contains "${output}" "Run it by hand." "terminal error hint"
assert_contains "${output}" "workflow_dispatch" "terminal error keeps stderr"
pass "cleanup_fail_if_terminal stops only on a terminal error"

# ---------------------------------------------------------------------------
# cleanup_gh_probe
# ---------------------------------------------------------------------------

GH_MODE=""
gh() {
    case "${GH_MODE}" in
    present) echo '{}' ;;
    absent) echo "gh: Not Found (HTTP 404)" >&2 && return 1 ;;
    forbidden) echo "gh: Forbidden (HTTP 403)" >&2 && return 1 ;;
    flaky) echo "gh: Bad Gateway (HTTP 502)" >&2 && return 1 ;;
    *) return 99 ;;
    esac
}

for case_pair in present:0 absent:1 forbidden:2 flaky:3; do
    GH_MODE="${case_pair%%:*}"
    assert_eq "$(status_of cleanup_gh_probe repos/o/r/environments/x)" \
        "${case_pair##*:}" "gh probe ${GH_MODE}"
done
pass "cleanup_gh_probe maps responses to probe codes"

# ---------------------------------------------------------------------------
# cleanup_namespace_probe
# ---------------------------------------------------------------------------

KUBECTL_MODE=""
kubectl() {
    case "${KUBECTL_MODE}" in
    present) echo "namespace/default" ;;
    absent) ;;
    forbidden)
        echo 'Error from server (Forbidden): namespaces "default" is forbidden' >&2
        return 1
        ;;
    flaky) echo "Unable to connect to the server: i/o timeout" >&2 && return 1 ;;
    *) return 99 ;;
    esac
}

for case_pair in present:0 absent:1 forbidden:2 flaky:3; do
    KUBECTL_MODE="${case_pair%%:*}"
    assert_eq "$(status_of cleanup_namespace_probe default)" \
        "${case_pair##*:}" "namespace probe ${KUBECTL_MODE}"
done
pass "cleanup_namespace_probe maps responses to probe codes"

# ---------------------------------------------------------------------------
# cleanup_wait_until_absent
# ---------------------------------------------------------------------------

# Reports PRESENT, then TRANSIENT, then ABSENT, and counts its calls.
PROBE_CALLS="${TEST_ROOT}/probe-calls"
eventually_absent() {
    local calls
    calls="$(($(cat "${PROBE_CALLS}" 2>/dev/null || echo 0) + 1))"
    echo "${calls}" >"${PROBE_CALLS}"
    case "${calls}" in
    1) return "${CLEANUP_PROBE_PRESENT}" ;;
    2) return "${CLEANUP_PROBE_TRANSIENT}" ;;
    *) return "${CLEANUP_PROBE_ABSENT}" ;;
    esac
}
always_present() { return "${CLEANUP_PROBE_PRESENT}"; }
always_terminal() {
    echo 1 >>"${PROBE_CALLS}"
    return "${CLEANUP_PROBE_TERMINAL}"
}

rm -f "${PROBE_CALLS}"
output="$(cleanup_wait_until_absent "thing" 60 5 eventually_absent)" ||
    fail "an object that goes away must verify"
assert_contains "${output}" "Verified that thing is gone." "gone message"
assert_eq "$(cat "${PROBE_CALLS}")" "3" "transient errors are retried"
pass "cleanup_wait_until_absent retries until the object is gone"

status=0
output="$(cleanup_wait_until_absent "thing" 0 5 always_present)" || status=$?
assert_eq "${status}" "1" "timeout status"
assert_contains "${output}" "thing still exists 0 seconds after its delete." \
    "timeout message"
pass "cleanup_wait_until_absent times out"

rm -f "${PROBE_CALLS}"
status=0
output="$(cleanup_wait_until_absent "thing" 600 5 always_terminal)" || status=$?
assert_eq "${status}" "2" "terminal status"
assert_eq "$(wc -l <"${PROBE_CALLS}" | tr -d ' ')" "1" \
    "a terminal error is not retried"
assert_contains "${output}" "a retry cannot fix" "terminal message"
pass "cleanup_wait_until_absent stops at once on a terminal error"

# A probe that stalls longer than the timeout. Its child stands in for a hung
# `kubectl` or `gh`, and it records its PID so the test can check it was killed.
CHILD_PID="${TEST_ROOT}/child-pid"
stalled_probe() {
    command sleep 30 &
    echo "$!" >"${CHILD_PID}"
    wait
    return "${CLEANUP_PROBE_ABSENT}"
}

status=0
started="${SECONDS}"
output="$(cleanup_wait_until_absent "thing" 2 1 stalled_probe 2>&1)" ||
    status=$?
assert_eq "${status}" "1" "a stalled probe ends in a timeout"
(((SECONDS - started) < 15)) ||
    fail "a stalled probe must stop at the timeout, not when it finishes"
assert_contains "${output}" "did not finish in" "stalled probe warning"
if kill -0 "$(cat "${CHILD_PID}")" 2>/dev/null; then
    fail "the child of a stalled probe must be stopped"
fi
pass "cleanup_wait_until_absent stops a probe that passes the deadline"

# The wait between calls never passes the deadline, even with a long interval.
SLEEPS="${TEST_ROOT}/sleeps"
sleep() { echo "$1" >>"${SLEEPS}"; }
status=0
output="$(cleanup_wait_until_absent "thing" 3 600 always_present)" ||
    status=$?
sleep() { :; }
assert_eq "${status}" "1" "capped sleep still times out"
while read -r seconds; do
    ((seconds <= 3)) || fail "a sleep of ${seconds} seconds passes the deadline"
done <"${SLEEPS}"
pass "cleanup_wait_until_absent caps each wait at the time that remains"

echo "all cloud-e2e-cleanup-lib tests passed"