#!/bin/bash

# Gives the target AKS kubeconfig a Microsoft Entra access token in place of the
# kubelogin credential that `az aks get-credentials` writes for a cluster with
# Microsoft Entra integration.
#
# Runner steps and the Radius pods (applications-rp, dynamic-rp, bicep-de) read
# the target kubeconfig. The pods read it from the target-kubeconfig Secret and
# cannot run a credential plugin, so the kubeconfig carries a bearer token. The
# token comes from the client-credentials flow, with a new GitHub OIDC token as
# the client assertion for the deploy identity's federated credential. Azure CLI
# is not used for the token: it keeps the GitHub token that azure/login gave it,
# and that token expires after five minutes.
#
# The kubeconfig names the Secret's `token` key in `tokenFile`. The Go clients
# in the pods re-read that file every minute. The Deployment Engine ignores
# `tokenFile` and re-reads the kubeconfig on every operation, so it uses the
# inline token. Runner steps have no such file and also use the inline token.
#
# Usage:
#   azure-aks-token.sh --convert
#       Run after `az aks get-credentials --file "$RADIUS_TARGET_KUBECONFIG"`.
#       A kubeconfig whose user does not run kubelogin is left unchanged.
#       Otherwise the user gets a token, and the settings that --renew needs are
#       exported through GITHUB_ENV. Needs AZURE_CLIENT_ID and AZURE_TENANT_ID.
#   azure-aks-token.sh --renew [github-oidc-token-file]
#       Gets a new token and stores the kubeconfig and the token in the
#       target-kubeconfig Secret on the control plane, then in the target
#       kubeconfig on the runner. Uses the given GitHub OIDC token as the client
#       assertion, or requests a new one.
#
# Each failure prints one GitHub annotation with a stable code. Set
# RADIUS_AKS_ANNOTATION=warning when a caller retries failed attempts.

set -euo pipefail
umask 077

# shellcheck source=.github/extension/scripts/github-oidc-token.sh
source "$(dirname "${BASH_SOURCE[0]}")/github-oidc-token.sh"

readonly MODE="${1:-}"
# The AKS server application, the token audience for every AKS cluster with
# AKS-managed Microsoft Entra integration.
readonly DEFAULT_SERVER_ID="6dae42f8-4368-4678-94ff-3960e28e3630"
readonly OIDC_AUDIENCE="api://AzureADTokenExchange"
readonly ASSERTION_TYPE="urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
readonly NAMESPACE="radius-system"
readonly SECRET_NAME="target-kubeconfig"
# Where the Radius chart mounts the target-kubeconfig Secret
# (global.targetCluster.mountPath), so the path of its `token` key in the pods.
readonly POD_TOKEN_FILE="/etc/radius/target-kubeconfig/token"
readonly CONNECT_TIMEOUT_SECONDS=5
readonly REQUEST_TIMEOUT_SECONDS=20
readonly ANNOTATION="${RADIUS_AKS_ANNOTATION:-error}"
readonly ENTRA_ID_PATTERN='^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
readonly AUTHORITY_PATTERN='^https://[A-Za-z0-9.-]+$'
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
readonly SCRIPT_PATH

WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/radius-aks-token.XXXXXX")"
readonly WORK_DIR
STAGED_KUBECONFIG=""
cleanup() {
    rm -rf "${WORK_DIR}"
    if [[ -n "${STAGED_KUBECONFIG}" ]]; then
        rm -f "${STAGED_KUBECONFIG}"
    fi
}
trap cleanup EXIT
readonly CONFIG_JSON="${WORK_DIR}/kubeconfig.json"
readonly ASSERTION_FILE="${WORK_DIR}/assertion"
readonly TOKEN_FILE="${WORK_DIR}/token"

# Prints one annotation and stops: report CODE MESSAGE FIX.
report() {
    local code="$1" title
    case "${code}" in
        AKS_KUBECONFIG_MISSING) title="AKS kubeconfig missing" ;;
        AKS_KUBECONFIG_UNREADABLE) title="AKS kubeconfig unreadable" ;;
        AKS_SERVER_ID_INVALID) title="AKS server application ID invalid" ;;
        AKS_SETTINGS_INVALID) title="AKS token settings invalid" ;;
        AKS_OIDC_UNAVAILABLE) title="GitHub OIDC token unavailable" ;;
        AKS_IDENTITY_REJECTED) title="AKS token request rejected" ;;
        AKS_SERVER_APP_REJECTED) title="AKS server application rejected" ;;
        AKS_TOKEN_REQUEST_INVALID) title="AKS token request invalid" ;;
        AKS_ENTRA_UNREACHABLE) title="Microsoft Entra unreachable" ;;
        AKS_TOKEN_UNAVAILABLE) title="AKS token unavailable" ;;
        AKS_SECRET_UPDATE_FAILED) title="AKS token not stored" ;;
    esac
    echo "::${ANNOTATION} title=${title}::[${code}] $2 Fix: $3"
    exit 1
}

require_entra_id() {
    local name="$1" value="$2" fix="$3"
    if [[ ! "${value}" =~ ${ENTRA_ID_PATTERN} ]]; then
        report AKS_SETTINGS_INVALID \
            "${name} is empty or is not a valid Microsoft Entra ID." "${fix}"
    fi
}

read_target_kubeconfig() {
    if [[ -z "${RADIUS_TARGET_KUBECONFIG:-}" || ! -f "${RADIUS_TARGET_KUBECONFIG}" ]]; then
        report AKS_KUBECONFIG_MISSING \
            "No AKS kubeconfig exists at RADIUS_TARGET_KUBECONFIG." \
            "Check the step that runs az aks get-credentials, then rerun the workflow."
    fi
    # Only the target kubeconfig is read. The runner's default kubeconfig can
    # describe another cluster.
    if ! kubectl --kubeconfig "${RADIUS_TARGET_KUBECONFIG}" config view \
        --raw --minify -o json >"${CONFIG_JSON}" 2>/dev/null ||
        ! jq -e '(.users | length) == 1 and (.clusters | length) == 1' \
            "${CONFIG_JSON}" >/dev/null 2>&1; then
        report AKS_KUBECONFIG_UNREADABLE \
            "kubectl could not read one user and one cluster from the current context of the AKS kubeconfig." \
            "Rerun the workflow."
    fi
}

runs_kubelogin() {
    [[ "$(jq -r '.users[0].user.exec.command // "" | split("/") | last' \
        "${CONFIG_JSON}")" == "kubelogin" ]]
}

server_id_from_kubeconfig() {
    jq -r --arg default "${DEFAULT_SERVER_ID}" '
        (.users[0].user.exec.args // []) as $args
        | [range(0; $args | length) as $i
            | if $args[$i] == "--server-id" then $args[$i + 1]
              elif ($args[$i] | startswith("--server-id=")) then
                $args[$i] | ltrimstr("--server-id=")
              else empty end
            | strings | select(length > 0)][0] // $default' "${CONFIG_JSON}"
}

# Writes the client assertion: the given GitHub OIDC token, or a new one.
prepare_assertion() {
    local given="$1"

    if [[ -n "${given}" ]]; then
        if [[ ! -s "${given}" ]]; then
            report AKS_OIDC_UNAVAILABLE \
                "The GitHub OIDC token file for the AKS token exchange is missing or empty." \
                "Rerun the workflow."
        fi
        echo "::add-mask::$(<"${given}")"
        cp "${given}" "${ASSERTION_FILE}"
        return 0
    fi
    if [[ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" || -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]; then
        report AKS_OIDC_UNAVAILABLE \
            "This job cannot request a GitHub OIDC token for the AKS token exchange." \
            "Give the job the id-token: write permission, then rerun the workflow."
    fi
    if ! request_github_oidc_token "${OIDC_AUDIENCE}" "${ASSERTION_FILE}"; then
        report AKS_OIDC_UNAVAILABLE \
            "GitHub did not return an OIDC token for the AKS token exchange (HTTP ${GITHUB_OIDC_STATUS})." \
            "Rerun the workflow."
    fi
}

# Exchanges the client assertion for a Microsoft Entra access token for the AKS
# server application, and writes it to TOKEN_FILE. The request body goes to
# curl from a file.
request_token() {
    local server_id="$1" client_id="$2" tenant_id="$3" authority="$4"
    local status error token

    jq -jn \
        --arg client_id "${client_id}" \
        --arg scope "${server_id}/.default" \
        --arg assertion_type "${ASSERTION_TYPE}" \
        --rawfile assertion "${ASSERTION_FILE}" \
        '"grant_type=client_credentials"
        + "&client_id=\($client_id | @uri)"
        + "&scope=\($scope | @uri)"
        + "&client_assertion_type=\($assertion_type | @uri)"
        + "&client_assertion=\($assertion | @uri)"' >"${WORK_DIR}/token-request"
    rm -f "${ASSERTION_FILE}"
    status="$(curl -sS \
        --connect-timeout "${CONNECT_TIMEOUT_SECONDS}" \
        --max-time "${REQUEST_TIMEOUT_SECONDS}" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-binary "@${WORK_DIR}/token-request" \
        -o "${WORK_DIR}/token-response" \
        -w '%{http_code}' \
        "${authority}/${tenant_id}/oauth2/v2.0/token")" || status="000"
    rm -f "${WORK_DIR}/token-request"

    if [[ "${status}" == "200" ]] &&
        token="$(jq -er '.access_token | strings | select(length > 0)' \
            "${WORK_DIR}/token-response" 2>/dev/null)"; then
        echo "::add-mask::${token}"
        printf '%s' "${token}" >"${TOKEN_FILE}"
        rm -f "${WORK_DIR}/token-response"
        return 0
    fi

    # Classify by the HTTP status and the OAuth `error` code only. The response
    # body is never printed, and error_description is free text that changes.
    error="$(jq -r '.error // empty | strings' "${WORK_DIR}/token-response" 2>/dev/null || true)"
    rm -f "${WORK_DIR}/token-response"
    if [[ ! "${error}" =~ ^[a-z_]{1,64}$ ]]; then
        error="no error code"
    fi
    case "${status}:${error}" in
        400:invalid_client | 401:invalid_client | 400:unauthorized_client | 401:unauthorized_client)
            report AKS_IDENTITY_REJECTED \
                "Microsoft Entra rejected the deploy identity's GitHub federated credential when Radius requested an AKS token (HTTP ${status}, ${error})." \
                "Rerun environment setup in Radius so it recreates the federated credential for this repository and GitHub environment."
            ;;
        400:invalid_scope | 400:invalid_resource)
            report AKS_SERVER_APP_REJECTED \
                "Microsoft Entra rejected the AKS server application ${server_id} from the cluster kubeconfig as a token scope (HTTP ${status}, ${error})." \
                "Confirm that the cluster uses AKS-managed Microsoft Entra integration, then rerun the workflow."
            ;;
        400:*)
            report AKS_TOKEN_REQUEST_INVALID \
                "Microsoft Entra rejected the AKS token request (HTTP ${status}, ${error})." \
                "Check that this GitHub environment's AZURE_CLIENT_ID and AZURE_TENANT_ID variables name the deploy identity, then rerun the workflow."
            ;;
        000:* | 5[0-9][0-9]:*)
            report AKS_ENTRA_UNREACHABLE \
                "Microsoft Entra did not answer the AKS token request (HTTP ${status})." \
                "Rerun the workflow."
            ;;
        *)
            report AKS_TOKEN_UNAVAILABLE \
                "Microsoft Entra did not return an AKS token (HTTP ${status})." \
                "Rerun the workflow."
            ;;
    esac
}

# Writes a copy of the kubeconfig whose current user has only the token, next
# to the target so that install_kubeconfig can replace it in one rename.
# Clusters, contexts, and names are unchanged.
stage_kubeconfig() {
    jq --rawfile token "${TOKEN_FILE}" --arg token_file "${POD_TOKEN_FILE}" \
        '.users[0].user = {token: $token, tokenFile: $token_file}' \
        "${CONFIG_JSON}" >"${WORK_DIR}/token-kubeconfig.json"
    STAGED_KUBECONFIG="$(mktemp "$(dirname "${RADIUS_TARGET_KUBECONFIG}")/.radius-aks-kubeconfig.XXXXXX")"
    kubectl config view --raw --kubeconfig "${WORK_DIR}/token-kubeconfig.json" \
        >"${STAGED_KUBECONFIG}"
    rm -f "${WORK_DIR}/token-kubeconfig.json"
}

install_kubeconfig() {
    mv "${STAGED_KUBECONFIG}" "${RADIUS_TARGET_KUBECONFIG}"
    STAGED_KUBECONFIG=""
}

# The Secret's `token` key is the file that the kubeconfig names in tokenFile.
store_secret() {
    if ! kubectl create secret generic "${SECRET_NAME}" \
        --namespace "${NAMESPACE}" \
        --from-file=kubeconfig="${STAGED_KUBECONFIG}" \
        --from-file=token="${TOKEN_FILE}" \
        --dry-run=client -o yaml |
        kubectl apply --request-timeout="${REQUEST_TIMEOUT_SECONDS}s" -f - >/dev/null; then
        report AKS_SECRET_UPDATE_FAILED \
            "Radius could not store the AKS token in the target-kubeconfig Secret on the control-plane cluster." \
            "Rerun the workflow."
    fi
}

convert() {
    local server_id authority

    read_target_kubeconfig
    if ! runs_kubelogin; then
        echo "The AKS kubeconfig does not run kubelogin. It is left unchanged."
        return 0
    fi

    server_id="$(server_id_from_kubeconfig)"
    if [[ ! "${server_id}" =~ ${ENTRA_ID_PATTERN} ]]; then
        report AKS_SERVER_ID_INVALID \
            "The kubelogin --server-id value in the AKS kubeconfig is not a valid application ID." \
            "Run az aks get-credentials for the cluster and check its --server-id value."
    fi
    local settings_fix="Check this GitHub environment's AZURE_CLIENT_ID and AZURE_TENANT_ID variables, then rerun the workflow."
    require_entra_id AZURE_CLIENT_ID "${AZURE_CLIENT_ID:-}" "${settings_fix}"
    require_entra_id AZURE_TENANT_ID "${AZURE_TENANT_ID:-}" "${settings_fix}"
    if [[ -z "${GITHUB_ENV:-}" ]]; then
        report AKS_SETTINGS_INVALID \
            "GITHUB_ENV is not set, so the AKS token settings cannot reach later steps." \
            "Run this script from a GitHub Actions step."
    fi
    authority="$(az cloud show --query endpoints.activeDirectory --output tsv 2>/dev/null || true)"
    authority="${authority%/}"
    if [[ ! "${authority}" =~ ${AUTHORITY_PATTERN} ]]; then
        report AKS_SETTINGS_INVALID \
            "Azure CLI did not report a Microsoft Entra authority for its cloud." \
            "Check that the Azure Login step succeeded, then rerun the workflow."
    fi

    prepare_assertion ""
    request_token "${server_id}" "${AZURE_CLIENT_ID}" "${AZURE_TENANT_ID}" "${authority}"
    stage_kubeconfig
    install_kubeconfig
    {
        echo "RADIUS_AKS_SERVER_ID=${server_id}"
        echo "RADIUS_AKS_CLIENT_ID=${AZURE_CLIENT_ID}"
        echo "RADIUS_AKS_TENANT_ID=${AZURE_TENANT_ID}"
        echo "RADIUS_AKS_AUTHORITY=${authority}"
        echo "RADIUS_AKS_TOKEN_SCRIPT=${SCRIPT_PATH}"
    } >>"${GITHUB_ENV}"
    echo "Replaced the kubelogin credential in the AKS kubeconfig with a Microsoft Entra token for server application ${server_id}."
}

# The settings came from --convert through GITHUB_ENV, so an invalid value means
# the job's environment changed after conversion.
renew() {
    local fix="Rerun the workflow."

    require_entra_id RADIUS_AKS_SERVER_ID "${RADIUS_AKS_SERVER_ID:-}" "${fix}"
    require_entra_id RADIUS_AKS_CLIENT_ID "${RADIUS_AKS_CLIENT_ID:-}" "${fix}"
    require_entra_id RADIUS_AKS_TENANT_ID "${RADIUS_AKS_TENANT_ID:-}" "${fix}"
    if [[ ! "${RADIUS_AKS_AUTHORITY:-}" =~ ${AUTHORITY_PATTERN} ]]; then
        report AKS_SETTINGS_INVALID \
            "RADIUS_AKS_AUTHORITY is not a Microsoft Entra authority URL." "${fix}"
    fi

    read_target_kubeconfig
    prepare_assertion "$1"
    request_token "${RADIUS_AKS_SERVER_ID}" "${RADIUS_AKS_CLIENT_ID}" \
        "${RADIUS_AKS_TENANT_ID}" "${RADIUS_AKS_AUTHORITY}"
    stage_kubeconfig
    # The Secret first: if it fails, the runner keeps a kubeconfig that matches it.
    store_secret
    install_kubeconfig
    echo "Renewed the Microsoft Entra token for AKS."
}

case "${MODE}" in
    --convert)
        convert
        ;;
    --renew)
        renew "${2:-}"
        ;;
    *)
        echo "Usage: $0 --convert | --renew [github-oidc-token-file]" >&2
        exit 2
        ;;
esac
