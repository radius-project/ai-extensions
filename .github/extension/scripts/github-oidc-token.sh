#!/bin/bash

# Requests GitHub Actions OIDC tokens for the cloud token scripts. Source this
# file, then call request_github_oidc_token with an audience and an output file.
# The request token goes to curl in a header file and the OIDC token goes to the
# output file, so neither appears in a command line. The OIDC token is masked in
# the step log. The function returns nonzero when GitHub returns no token and
# leaves the HTTP status in GITHUB_OIDC_STATUS.

readonly GITHUB_OIDC_CONNECT_TIMEOUT_SECONDS=5
readonly GITHUB_OIDC_REQUEST_TIMEOUT_SECONDS=20
GITHUB_OIDC_STATUS=""

request_github_oidc_token() {
    local audience="$1" output="$2" work_dir token

    GITHUB_OIDC_STATUS="000"
    if [[ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" || -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]; then
        return 1
    fi
    work_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/github-oidc.XXXXXX")" || return 1
    chmod 700 "${work_dir}"
    printf 'Authorization: bearer %s\n' "${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
        >"${work_dir}/header"
    GITHUB_OIDC_STATUS="$(curl -sS \
        --connect-timeout "${GITHUB_OIDC_CONNECT_TIMEOUT_SECONDS}" \
        --max-time "${GITHUB_OIDC_REQUEST_TIMEOUT_SECONDS}" \
        -H "@${work_dir}/header" \
        -o "${work_dir}/response" \
        -w '%{http_code}' \
        "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${audience}")" || GITHUB_OIDC_STATUS="000"
    if [[ "${GITHUB_OIDC_STATUS}" != "200" ]] ||
        ! token="$(jq -er '.value | strings | select(length > 0)' \
            "${work_dir}/response" 2>/dev/null)"; then
        rm -rf "${work_dir}"
        return 1
    fi
    rm -rf "${work_dir}"
    echo "::add-mask::${token}"
    printf '%s' "${token}" >"${output}"
}
