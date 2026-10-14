#!/usr/bin/env bash
# Writes the AWS recipe registry credentials into the control-plane cluster.
#
# Radius v0.61.1 reads a Radius.Security/secrets resource's backing Kubernetes
# Secret with the control plane's own client, but the secrets recipe writes it
# to the target EKS cluster. Every recipe operation in an environment that
# references the radius-recipe-registry bicepSettings loads that secret, so
# deploy and delete workflows both need this copy in kubectl's default context
# (the k3d control plane), under the environment namespace and the same name.
set -euo pipefail

: "${NAMESPACE:?}" "${REGISTRY_USERNAME:?}" "${REGISTRY_PASSWORD:?}"
SECRET_NAME="${SECRET_NAME:-radius-recipe-registry}"

WORK=$(mktemp -d "${RUNNER_TEMP:-/tmp}/aws-recipe-registry.XXXXXX")
trap 'rm -rf "${WORK}"' EXIT
(
  umask 077
  printf '%s' "${REGISTRY_USERNAME}" > "${WORK}/username"
  printf '%s' "${REGISTRY_PASSWORD}" > "${WORK}/password"
)

echo "Writing recipe registry credentials into the control-plane cluster..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic "${SECRET_NAME}" --namespace "${NAMESPACE}" \
  --from-file=username="${WORK}/username" \
  --from-file=password="${WORK}/password" \
  --dry-run=client -o yaml | kubectl apply -f -
