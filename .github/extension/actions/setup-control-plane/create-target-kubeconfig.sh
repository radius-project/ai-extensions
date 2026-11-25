#!/usr/bin/env bash

set -euo pipefail

if [[ ! -f "${RADIUS_TARGET_KUBECONFIG:-}" ]]; then
    echo "No target kubeconfig; resources will deploy to the control-plane cluster."
    exit 0
fi

apply_when_schema_ready() {
    local delay output code manifest attempt=0
    manifest="$(kubectl --request-timeout=10s create "$@" --dry-run=client -o yaml)" ||
        return "$?"
    for delay in 0 1 2 4 8; do
        if ((delay > 0)); then
            sleep "${delay}"
        fi
        attempt=$((attempt + 1))
        if output="$(kubectl --request-timeout=10s apply -f - <<<"${manifest}" 2>&1)"; then
            printf '%s\n' "${output}"
            return 0
        else
            code=$?
        fi
        printf '%s\n' "${output}" >&2
        # Node Ready does not prove the fresh API can serve its OpenAPI schema.
        # This validation failure occurs before apply sends the resource write.
        if [[ "${output}" != *"error validating "*"failed to download openapi: the server is currently unable to handle the request"* ]]; then
            return "${code}"
        fi
        if ((attempt == 5)); then
            echo "::error::The control-plane OpenAPI schema remained unavailable after 5 attempts." >&2
            return "${code}"
        fi
        echo "::warning::The control-plane OpenAPI schema is not available yet; retrying preparation (attempt ${attempt}/5)." >&2
    done
}

apply_when_schema_ready namespace radius-system
apply_when_schema_ready secret generic target-kubeconfig \
    --namespace radius-system \
    --from-file=kubeconfig="${RADIUS_TARGET_KUBECONFIG}"
