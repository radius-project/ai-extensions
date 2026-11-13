#!/bin/bash

# Refreshes the GitHub OIDC assertion mounted into Radius Azure consumers.
#
# When the AKS kubeconfig uses a Microsoft Entra token (RADIUS_AKS_SERVER_ID is
# set by the aks-token-kubeconfig action), each refresh also gets a new AKS token
# and writes it to the target-kubeconfig Secret, both inline in the kubeconfig
# and under the `token` key that the kubeconfig names in `tokenFile`, and to the
# runner's copy of the kubeconfig.

set -euo pipefail

# shellcheck source=.github/extension/scripts/token-refresh-watch.sh
source "$(dirname "${BASH_SOURCE[0]}")/token-refresh-watch.sh"
# shellcheck source=.github/extension/scripts/github-oidc-token.sh
source "$(dirname "${BASH_SOURCE[0]}")/github-oidc-token.sh"

readonly MODE="${1:-}"
readonly MAX_REFRESHES="${2:-0}"
readonly AUDIENCE="api://AzureADTokenExchange"
readonly NAMESPACE="radius-system"
readonly SECRET_NAME="azure-oidc-token"
readonly TOKEN_KEY="azure-identity-token"
readonly CONSUMERS=(applications-rp dynamic-rp bicep-de)
# GitHub Actions OIDC tokens expire after 5 minutes, so refresh well inside that
# window and leave room for kubelet to propagate the updated Secret volume.
# Microsoft Entra tokens for AKS last at least 10 minutes.
readonly REFRESH_INTERVAL_SECONDS="${AZURE_OIDC_REFRESH_INTERVAL_SECONDS:-120}"
readonly REQUEST_TIMEOUT_SECONDS=20
readonly AKS_SERVER_ID="${RADIUS_AKS_SERVER_ID:-}"
AKS_TOKEN_SCRIPT="$(dirname "${BASH_SOURCE[0]}")/azure-aks-token.sh"
readonly AKS_TOKEN_SCRIPT

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

# The GitHub OIDC token is written to a file only this user can read, so it
# never appears in a command line.
TOKEN_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/radius-azure-tokens.XXXXXX")"
readonly TOKEN_DIR
trap 'rm -rf "${TOKEN_DIR}"' EXIT
chmod 700 "${TOKEN_DIR}"
readonly OIDC_TOKEN_FILE="${TOKEN_DIR}/oidc-token"

refresh_token() {
    request_github_oidc_token "${AUDIENCE}" "${OIDC_TOKEN_FILE}" || return 1
    kubectl create secret generic "${SECRET_NAME}" \
        --namespace "${NAMESPACE}" \
        --from-file="${TOKEN_KEY}=${OIDC_TOKEN_FILE}" \
        --dry-run=client -o yaml |
        kubectl apply --request-timeout="${REQUEST_TIMEOUT_SECONDS}s" -f - >/dev/null
}

# Renews the AKS token with the GitHub OIDC token that refresh_token just got.
# azure-aks-token.sh updates the target-kubeconfig Secret and the runner's
# kubeconfig. Its failures are warnings while watching, because the next
# attempt retries them.
refresh_tokens() {
    refresh_token || return 1
    if [[ -n "${AKS_SERVER_ID}" ]]; then
        RADIUS_AKS_ANNOTATION="${AKS_ANNOTATION}" \
            bash "${AKS_TOKEN_SCRIPT}" --renew "${OIDC_TOKEN_FILE}" || return 1
    fi
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
        AKS_ANNOTATION=error
        refresh_tokens
        restart_consumers
        echo "Azure OIDC token refreshed and consumers restarted."
        ;;
    --watch)
        AKS_ANNOTATION=warning
        watch_token_refresh refresh_tokens \
            "Azure OIDC token refreshed." \
            "Azure OIDC token refresh failed; retrying." \
            "${REFRESH_INTERVAL_SECONDS}" "${MAX_REFRESHES}"
        ;;
    *)
        echo "Usage: $0 --prepare | --watch [refresh-count]" >&2
        exit 2
        ;;
esac
