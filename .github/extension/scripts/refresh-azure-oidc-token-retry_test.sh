#!/bin/bash

# Tests the retry schedule of refresh-azure-oidc-token.sh --watch without cloud
# or cluster access: a failed refresh is retried after 15 seconds, and refreshes
# that succeed keep the normal interval.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly SCRIPT="${SCRIPT_DIR}/refresh-azure-oidc-token.sh"
TEMP_DIR="$(mktemp -d)"
readonly TEMP_DIR
trap 'rm -rf "${TEMP_DIR}"' EXIT

mkdir -p "${TEMP_DIR}/bin"

# Fails the requests whose numbers are listed in CURL_FAILURES.
cat >"${TEMP_DIR}/bin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
count=0
if [[ -f "${CURL_COUNT_FILE}" ]]; then
    count="$(cat "${CURL_COUNT_FILE}")"
fi
((count += 1))
printf '%s' "${count}" >"${CURL_COUNT_FILE}"
if [[ " ${CURL_FAILURES:-} " == *" ${count} "* ]]; then
    exit 22
fi
printf '{"value":"token-%s"}\n' "${count}"
EOF

cat >"${TEMP_DIR}/bin/kubectl" <<'EOF'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == "create" ]]; then
    for argument in "$@"; do
        case "${argument}" in
            --from-literal=*)
                printf '%s\n' "${argument#*=}"
                exit 0
                ;;
        esac
    done
    exit 1
fi
if [[ "${1:-}" == "apply" ]]; then
    cat >>"${KUBECTL_APPLY_FILE}"
    exit 0
fi
exit 1
EOF

cat >"${TEMP_DIR}/bin/sleep" <<'EOF'
#!/bin/bash
printf '%s\n' "$1" >>"${SLEEP_FILE}"
EOF

chmod +x "${TEMP_DIR}/bin/curl" "${TEMP_DIR}/bin/kubectl" "${TEMP_DIR}/bin/sleep"

export PATH="${TEMP_DIR}/bin:${PATH}"
export ACTIONS_ID_TOKEN_REQUEST_TOKEN="request-token"
export ACTIONS_ID_TOKEN_REQUEST_URL="https://oidc.example/token?job=1"
export CURL_COUNT_FILE="${TEMP_DIR}/curl-count"
export KUBECTL_APPLY_FILE="${TEMP_DIR}/kubectl-apply"
export SLEEP_FILE="${TEMP_DIR}/sleeps"
unset AZURE_OIDC_REFRESH_INTERVAL_SECONDS

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

reset() {
    rm -f "${CURL_COUNT_FILE}" "${KUBECTL_APPLY_FILE}" "${SLEEP_FILE}"
}

# Prints the sleeps on one line, for example "120 15 120".
sleeps() {
    tr '\n' ' ' <"${SLEEP_FILE}" | sed 's/ $//'
}

# Nothing fails: every refresh waits the default 2-minute interval.
reset
output="$(bash "${SCRIPT}" --watch 3 2>&1)"
[[ "$(sleeps)" == "120 120 120" ]] ||
    fail "expected three 120-second waits without failures, got '$(sleeps)'"
[[ "$(grep -c '^Azure OIDC token refreshed\.$' <<<"${output}")" == "3" ]] ||
    fail "expected three refresh messages, got: ${output}"
[[ "${output}" != *"::warning::"* ]] || fail "expected no warning without failures"

# A failure is retried after 15 seconds, and the next success goes back to the
# normal interval.
reset
output="$(CURL_FAILURES="1" bash "${SCRIPT}" --watch 3 2>&1)"
[[ "$(sleeps)" == "120 15 120" ]] ||
    fail "expected a 15-second retry after one failure, got '$(sleeps)'"
[[ "$(grep -c '^::warning::Azure OIDC token refresh failed; retrying\.$' \
    <<<"${output}")" == "1" ]] || fail "expected one failure warning, got: ${output}"
[[ "$(grep -c '^Azure OIDC token refreshed\.$' <<<"${output}")" == "2" ]] ||
    fail "expected two refresh messages after the retry, got: ${output}"
expected_updates=$'azure-identity-token=token-2\nazure-identity-token=token-3'
[[ "$(cat "${KUBECTL_APPLY_FILE}")" == "${expected_updates}" ]] ||
    fail "expected the retried tokens to update the Secret"

# Failures in a row keep retrying every 15 seconds until one succeeds.
reset
CURL_FAILURES="1 2 3" bash "${SCRIPT}" --watch 4 >/dev/null 2>&1
[[ "$(sleeps)" == "120 15 15 15" ]] ||
    fail "expected 15-second retries until a refresh succeeds, got '$(sleeps)'"

# An interval shorter than the retry delay is never lengthened by a failure.
reset
AZURE_OIDC_REFRESH_INTERVAL_SECONDS=5 CURL_FAILURES="1" \
    bash "${SCRIPT}" --watch 2 >/dev/null 2>&1
[[ "$(sleeps)" == "5 5" ]] ||
    fail "expected a short interval to cap the retry delay, got '$(sleeps)'"

echo "refresh-azure-oidc-token retry tests passed"
