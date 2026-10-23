#!/bin/bash

# ============================================================================
# Helpers shared by the steps in `.github/workflows/cloud-e2e-cleanup.yml`.
#
# Source this file; do not execute it. Every step that deletes something uses
# these helpers to:
#
#   * stop at once when a call fails in a way that a retry cannot fix, such as
#     a missing token permission or a workflow that no longer exists, and
#   * verify, with a bounded wait, that a deleted object is really gone.
#
# A probe function returns one of these codes:
#
#   0  the object still exists
#   1  the object is gone
#   2  terminal error: a retry cannot fix it
#   3  transient error: try again until the timeout
#   4  the probe did not finish in its time budget
# ============================================================================

readonly CLEANUP_PROBE_PRESENT=0
readonly CLEANUP_PROBE_ABSENT=1
readonly CLEANUP_PROBE_TERMINAL=2
readonly CLEANUP_PROBE_TRANSIENT=3
readonly CLEANUP_PROBE_TIMED_OUT=4

# Prints the last HTTP status that `gh api` wrote to the given stderr file, or
# nothing when the file has no status.
cleanup_http_status() {
    local stderr_file="$1"
    grep -oE 'HTTP [0-9]{3}' "${stderr_file}" 2>/dev/null |
        tail -n 1 |
        cut -d' ' -f2 ||
        true
}

# Succeeds when an HTTP status cannot change on a retry. 404 is not listed,
# because callers treat it as "the object is gone".
cleanup_is_terminal_http_status() {
    case "$1" in
    400 | 401 | 403 | 405 | 409 | 410 | 422) return 0 ;;
    *) return 1 ;;
    esac
}

# Succeeds when the `gh api` stderr in the given file shows a terminal error.
# GitHub also answers 403 for a secondary rate limit, which a retry can fix.
cleanup_is_terminal_gh_error() {
    local stderr_file="$1" status
    if grep -qi 'rate limit' "${stderr_file}" 2>/dev/null; then
        return 1
    fi
    status="$(cleanup_http_status "${stderr_file}")"
    [[ -n "${status}" ]] && cleanup_is_terminal_http_status "${status}"
}

# Stops the step at once when the `gh api` stderr in the given file shows a
# terminal error. The optional hint tells the operator what to change.
#
# Usage: cleanup_fail_if_terminal STDERR_FILE WHAT [HINT]
cleanup_fail_if_terminal() {
    local stderr_file="$1" what="$2" hint="${3:-}" status
    if ! cleanup_is_terminal_gh_error "${stderr_file}"; then
        return 0
    fi
    status="$(cleanup_http_status "${stderr_file}")"
    cat "${stderr_file}" >&2
    echo "::error::${what} failed with HTTP ${status}. A retry cannot fix this, so cleanup stops now.${hint:+ ${hint}}"
    exit 1
}

# Probes one GitHub REST path with `gh api`. A 404 means the object is gone.
#
# Usage: cleanup_gh_probe API_PATH
cleanup_gh_probe() {
    local api_path="$1" stderr_file status
    stderr_file="$(mktemp)"
    if gh api "${api_path}" >/dev/null 2>"${stderr_file}"; then
        rm -f "${stderr_file}"
        return "${CLEANUP_PROBE_PRESENT}"
    fi
    status="$(cleanup_http_status "${stderr_file}")"
    if [[ "${status}" == "404" ]]; then
        rm -f "${stderr_file}"
        return "${CLEANUP_PROBE_ABSENT}"
    fi
    cat "${stderr_file}" >&2
    if cleanup_is_terminal_gh_error "${stderr_file}"; then
        rm -f "${stderr_file}"
        return "${CLEANUP_PROBE_TERMINAL}"
    fi
    rm -f "${stderr_file}"
    return "${CLEANUP_PROBE_TRANSIENT}"
}

# Probes one Kubernetes namespace. Missing credentials or RBAC are terminal.
#
# Usage: cleanup_namespace_probe NAMESPACE
cleanup_namespace_probe() {
    local namespace="$1" output
    if output="$(kubectl get namespace "${namespace}" \
        --ignore-not-found --request-timeout=30s --output name 2>&1)"; then
        if [[ -n "${output}" ]]; then
            return "${CLEANUP_PROBE_PRESENT}"
        fi
        return "${CLEANUP_PROBE_ABSENT}"
    fi
    printf '%s\n' "${output}" >&2
    if grep -qiE 'forbidden|unauthorized|must be logged in' <<<"${output}"; then
        return "${CLEANUP_PROBE_TERMINAL}"
    fi
    return "${CLEANUP_PROBE_TRANSIENT}"
}

# Runs PROBE with its arguments for at most BUDGET_SECONDS. The probe runs in
# its own process group, so a stalled `gh`, `az`, or `kubectl` that it starts
# is stopped with it. The probe runs without `set -e`, as it did when callers
# ran it on the left of `||`.
#
# Returns the probe's status, or CLEANUP_PROBE_TIMED_OUT when the budget ends
# first.
#
# Usage: cleanup_run_bounded BUDGET_SECONDS PROBE [ARGS...]
cleanup_run_bounded() {
    local budget="$1"
    shift
    local marker probe watchdog status=0 monitor_was_on=0
    marker="$(mktemp)"
    rm -f "${marker}"
    [[ "$-" == *m* ]] && monitor_was_on=1
    set -m
    (
        set +e
        "$@"
    ) &
    probe=$!
    ((monitor_was_on)) || set +m
    (
        timer=""
        trap '[[ -z "${timer}" ]] || kill "${timer}" 2>/dev/null; exit 0' TERM
        command sleep "${budget}" >/dev/null 2>&1 &
        timer=$!
        wait "${timer}" || exit 0
        : >"${marker}"
        kill -TERM -- "-${probe}" 2>/dev/null || kill -TERM "${probe}" 2>/dev/null
    ) &
    watchdog=$!
    wait "${probe}" || status=$?
    kill -TERM "${watchdog}" 2>/dev/null || true
    wait "${watchdog}" 2>/dev/null || true
    if [[ -e "${marker}" ]]; then
        rm -f "${marker}"
        echo "::warning::The check did not finish in ${budget} seconds, so it was stopped." >&2
        return "${CLEANUP_PROBE_TIMED_OUT}"
    fi
    return "${status}"
}

# Calls PROBE with its arguments until it reports the object is gone, the
# timeout expires, or the probe reports a terminal error. Each call gets only
# the time that remains, and the wait between calls never passes the deadline.
#
# Returns 0 when the object is gone, 1 on timeout, and 2 on a terminal error.
#
# Usage: cleanup_wait_until_absent LABEL TIMEOUT_SECONDS INTERVAL_SECONDS \
#          PROBE [ARGS...]
cleanup_wait_until_absent() {
    local label="$1" timeout="$2" interval="$3"
    shift 3
    local deadline=$((SECONDS + timeout)) remaining status
    while true; do
        remaining=$((deadline - SECONDS))
        ((remaining >= 1)) || remaining=1
        status=0
        cleanup_run_bounded "${remaining}" "$@" || status=$?
        case "${status}" in
        "${CLEANUP_PROBE_ABSENT}")
            echo "Verified that ${label} is gone."
            return 0
            ;;
        "${CLEANUP_PROBE_PRESENT}" | "${CLEANUP_PROBE_TRANSIENT}" | "${CLEANUP_PROBE_TIMED_OUT}") ;;
        *)
            echo "::error::Could not verify that ${label} is gone. The check failed in a way that a retry cannot fix."
            return 2
            ;;
        esac
        remaining=$((deadline - SECONDS))
        if ((remaining <= 0)); then
            echo "::error::${label} still exists ${timeout} seconds after its delete."
            return 1
        fi
        sleep "$((interval < remaining ? interval : remaining))"
    done
}
