#!/bin/bash

# Refreshes the GitHub OIDC token and the EKS token that Radius AWS consumers read.
#
# The GitHub token goes to the aws-oidc-token Secret, which is mounted at the IRSA
# token path. The EKS token goes to the target-kubeconfig Secret twice: as the
# `token` key, which the kubeconfig names in `tokenFile`, and inline in the
# kubeconfig. The Go consumers (applications-rp, dynamic-rp, and the Terraform
# kubernetes provider) re-read `tokenFile` every minute and keep their clients
# for the whole deploy. The Deployment Engine's Kubernetes client ignores
# `tokenFile`, but it re-reads the kubeconfig on every operation, so it uses the
# inline token.

set -euo pipefail

# shellcheck source=.github/extension/scripts/token-refresh-watch.sh
source "$(dirname "${BASH_SOURCE[0]}")/token-refresh-watch.sh"

readonly MODE="${1:-}"
readonly MAX_REFRESHES="${2:-0}"
readonly AUDIENCE="sts.amazonaws.com"
readonly NAMESPACE="radius-system"
readonly OIDC_SECRET_NAME="aws-oidc-token"
readonly KUBECONFIG_SECRET_NAME="target-kubeconfig"
# Where the Radius chart mounts the target-kubeconfig Secret
# (global.targetCluster.mountPath), so the path of its `token` key in the pods.
readonly POD_TOKEN_FILE="/etc/radius/target-kubeconfig/token"
readonly ROLE_SESSION_NAME="radius-token-refresh"
# GitHub Actions OIDC tokens expire after 5 minutes and EKS tokens after 15, so
# refresh well inside both and leave room for kubelet to propagate the Secrets.
readonly REFRESH_INTERVAL_SECONDS="${AWS_TOKEN_REFRESH_INTERVAL_SECONDS:-120}"
readonly CONNECT_TIMEOUT_SECONDS=5
readonly REQUEST_TIMEOUT_SECONDS=20
readonly CLUSTER="${RADIUS_AWS_EKS_CLUSTER_NAME:-}"

required=(ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL
    RADIUS_AWS_ROLE_ARN RADIUS_AWS_REGION)
if [[ -n "${CLUSTER}" ]]; then
    required+=(RADIUS_TARGET_KUBECONFIG)
fi
for variable in "${required[@]}"; do
    if [[ -z "${!variable:-}" ]]; then
        echo "Missing required environment variable: ${variable}" >&2
        exit 1
    fi
done

if [[ ! "${REFRESH_INTERVAL_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
    echo "AWS_TOKEN_REFRESH_INTERVAL_SECONDS must be a positive integer." >&2
    exit 1
fi

if [[ ! "${MAX_REFRESHES}" =~ ^[0-9]+$ ]]; then
    echo "Refresh count must be a non-negative integer." >&2
    exit 1
fi

# The GitHub and EKS tokens are written to files only this user can read, so
# they never appear in a command line.
TOKEN_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/radius-aws-tokens.XXXXXX")"
readonly TOKEN_DIR
trap 'rm -rf "${TOKEN_DIR}"' EXIT
chmod 700 "${TOKEN_DIR}"
readonly OIDC_TOKEN_FILE="${TOKEN_DIR}/oidc-token"
readonly EKS_TOKEN_FILE="${TOKEN_DIR}/eks-token"
readonly KUBECONFIG_FILE="${TOKEN_DIR}/kubeconfig"

CLUSTER_SERVER=""
CLUSTER_CA_DATA=""
if [[ -n "${CLUSTER}" ]]; then
    if [[ ! -f "${RADIUS_TARGET_KUBECONFIG}" ]]; then
        echo "No EKS kubeconfig at RADIUS_TARGET_KUBECONFIG; the Connect to EKS cluster step creates it." >&2
        exit 1
    fi
    CLUSTER_SERVER="$(kubectl config view --raw \
        --kubeconfig "${RADIUS_TARGET_KUBECONFIG}" \
        -o jsonpath='{.clusters[0].cluster.server}')"
    CLUSTER_CA_DATA="$(kubectl config view --raw \
        --kubeconfig "${RADIUS_TARGET_KUBECONFIG}" \
        -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
    if [[ -z "${CLUSTER_SERVER}" || -z "${CLUSTER_CA_DATA}" ]]; then
        echo "The EKS kubeconfig at RADIUS_TARGET_KUBECONFIG has no cluster server or certificate authority." >&2
        exit 1
    fi
fi

apply_secret() {
    local name="$1"
    shift

    kubectl create secret generic "${name}" \
        --namespace "${NAMESPACE}" \
        "$@" \
        --dry-run=client -o yaml |
        kubectl apply --request-timeout="${REQUEST_TIMEOUT_SECONDS}s" -f - >/dev/null
}

refresh_oidc_token() {
    local token

    token="$(curl -fsS \
        --connect-timeout "${CONNECT_TIMEOUT_SECONDS}" \
        --max-time "${REQUEST_TIMEOUT_SECONDS}" \
        -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
        "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}" |
        jq -er '.value | strings | select(length > 0)')" || return 1
    printf '%s' "${token}" >"${OIDC_TOKEN_FILE}"

    apply_secret "${OIDC_SECRET_NAME}" --from-file=token="${OIDC_TOKEN_FILE}"
}

# Signs in with the new GitHub token rather than the runner's AWS session, which
# expires after an hour.
refresh_eks_token() {
    local token

    token="$(env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
        -u AWS_SESSION_TOKEN -u AWS_PROFILE \
        AWS_ROLE_ARN="${RADIUS_AWS_ROLE_ARN}" \
        AWS_WEB_IDENTITY_TOKEN_FILE="${OIDC_TOKEN_FILE}" \
        AWS_ROLE_SESSION_NAME="${ROLE_SESSION_NAME}" \
        aws eks get-token \
        --cluster-name "${CLUSTER}" \
        --region "${RADIUS_AWS_REGION}" \
        --cli-connect-timeout "${CONNECT_TIMEOUT_SECONDS}" \
        --cli-read-timeout "${REQUEST_TIMEOUT_SECONDS}" \
        --output json |
        jq -er '.status.token | strings | select(length > 0)')" || return 1
    printf '%s' "${token}" >"${EKS_TOKEN_FILE}"

    printf 'apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: %s\n    server: %s\n  name: eks\ncontexts:\n- context:\n    cluster: eks\n    user: eks-user\n  name: eks\ncurrent-context: eks\nkind: Config\nusers:\n- name: eks-user\n  user:\n    token: %s\n    tokenFile: %s\n' \
        "${CLUSTER_CA_DATA}" "${CLUSTER_SERVER}" "${token}" "${POD_TOKEN_FILE}" \
        >"${KUBECONFIG_FILE}"

    apply_secret "${KUBECONFIG_SECRET_NAME}" \
        --from-file=kubeconfig="${KUBECONFIG_FILE}" \
        --from-file=token="${EKS_TOKEN_FILE}" || return 1
    # Runner steps such as the routes Gateway cleanup read the same kubeconfig.
    cp "${KUBECONFIG_FILE}" "${RADIUS_TARGET_KUBECONFIG}.new" &&
        mv "${RADIUS_TARGET_KUBECONFIG}.new" "${RADIUS_TARGET_KUBECONFIG}"
}

refresh_tokens() {
    refresh_oidc_token || return 1
    if [[ -n "${CLUSTER}" ]]; then
        refresh_eks_token || return 1
    fi
}

case "${MODE}" in
    --prepare)
        if ! refresh_tokens; then
            echo "Could not refresh the GitHub or EKS token. Check that the AWS deploy role trusts this repository's GitHub environment and has an access entry on the EKS cluster." >&2
            exit 1
        fi
        echo "AWS tokens refreshed."
        ;;
    --watch)
        watch_token_refresh refresh_tokens \
            "AWS tokens refreshed." \
            "AWS token refresh failed; retrying." \
            "${REFRESH_INTERVAL_SECONDS}" "${MAX_REFRESHES}"
        ;;
    *)
        echo "Usage: $0 --prepare | --watch [refresh-count]" >&2
        exit 2
        ;;
esac
