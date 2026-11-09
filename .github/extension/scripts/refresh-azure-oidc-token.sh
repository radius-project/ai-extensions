#!/bin/bash

# Refreshes the GitHub OIDC assertion mounted into Radius Azure consumers.

set -euo pipefail

# shellcheck source=.github/extension/scripts/token-refresh-watch.sh
source "$(dirname "${BASH_SOURCE[0]}")/token-refresh-watch.sh"

readonly MODE="${1:-}"
readonly MAX_REFRESHES="${2:-0}"
readonly AUDIENCE="api://AzureADTokenExchange"
readonly NAMESPACE="radius-system"
readonly SECRET_NAME="azure-oidc-token"
readonly TOKEN_KEY="azure-identity-token"
readonly CONSUMERS=(applications-rp dynamic-rp bicep-de)
# GitHub Actions OIDC tokens expire after 5 minutes, so refresh well inside that
# window and leave room for kubelet to propagate the updated Secret volume.
readonly REFRESH_INTERVAL_SECONDS="${AZURE_OIDC_REFRESH_INTERVAL_SECONDS:-120}"
readonly CONNECT_TIMEOUT_SECONDS=5
readonly REQUEST_TIMEOUT_SECONDS=20

for variable in ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL; do
    if [[ -z "${!variable:-}" ]]; then
        echo "Missing required environment variable: ${variable}" >&2
        exit 1
    fi
done

if [[ ! "${REFRESH_INTERVAL_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
    echo "AZURE_OIDC_REFRESH_INTERVAL_SECONDS must be a positive integer." >&2
    exit 1
fi

if [[ ! "${MAX_REFRESHES}" =~ ^[0-9]+$ ]]; then
    echo "Refresh count must be a non-negative integer." >&2
    exit 1
fi

refresh_token() {
    local token

    token="$(curl -fsS \
        --connect-timeout "${CONNECT_TIMEOUT_SECONDS}" \
        --max-time "${REQUEST_TIMEOUT_SECONDS}" \
        -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
        "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}" |
        jq -er '.value | strings | select(length > 0)')" || return 1

    kubectl create secret generic "${SECRET_NAME}" \
        --namespace "${NAMESPACE}" \
        --from-literal="${TOKEN_KEY}=${token}" \
        --dry-run=client -o yaml |
        kubectl apply --request-timeout="${REQUEST_TIMEOUT_SECONDS}s" -f - >/dev/null
}

restart_consumers() {
    local deployment

    for deployment in "${CONSUMERS[@]}"; do
        kubectl rollout restart "deployment/${deployment}" \
            --namespace "${NAMESPACE}" >/dev/null
    done
    for deployment in "${CONSUMERS[@]}"; do
        kubectl rollout status "deployment/${deployment}" \
            --namespace "${NAMESPACE}" --timeout=300s
    done
}

case "${MODE}" in
    --prepare)
        refresh_token
        restart_consumers
        echo "Azure OIDC token refreshed and consumers restarted."
        ;;
    --watch)
        watch_token_refresh refresh_token \
            "Azure OIDC token refreshed." \
            "Azure OIDC token refresh failed; retrying." \
            "${REFRESH_INTERVAL_SECONDS}" "${MAX_REFRESHES}"
        ;;
    *)
        echo "Usage: $0 --prepare | --watch [refresh-count]" >&2
        exit 2
        ;;
esac
