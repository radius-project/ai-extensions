#!/usr/bin/env bash
# Creates the Radius environment for an AWS GitHub environment and deploys the
# AWS recipe pack:
#   1. creates the Radius environment (AWS account and region, Kubernetes namespace),
#   2. publishes the AWS Bicep recipes in ./recipes to the repository's GHCR,
#   3. lets Radius pull them with the job's GitHub token through a
#      Radius.Core/bicepSettings resource referenced by the environment,
#   4. deploys a recipe pack mapping backing services to those recipes and core
#      primitives to the pinned Kubernetes recipes the Azure pack uses.
# RabbitMQ runs on the cluster through the Kubernetes recipe: an Amazon MQ broker
# is recreated on every Radius redeploy because its only identifier is generated
# by AWS. Kafka has no recipe: MSK does not return its bootstrap brokers to
# Bicep, and there is no Kubernetes Kafka recipe yet.
# Writes `recipe-pack=<name>` to GITHUB_OUTPUT for the attach step.
set -euo pipefail

: "${ENVIRONMENT:?}" "${NAMESPACE:?}" "${AWS_ACCOUNT_ID:?}" "${AWS_REGION:?}"
: "${EKS_CLUSTER_NAME:?}" "${VPC_ID:?}" "${SUBNET_IDS:?}"
: "${BUILD_REGISTRY:?}" "${REGISTRY_SECRET_NAME:?}"
: "${ROUTES_GATEWAY_NAME:?}" "${ROUTES_GATEWAY_NAMESPACE:?}"
: "${REGISTRY_USERNAME:?}" "${REGISTRY_PASSWORD:?}" "${RECIPE_REGISTRY:?}"
: "${ACTION_PATH:?}" "${RADIUS_CONTRIB_CATALOG_HELPER:?}"

PACK_NAME="aws-bicep"
# GHCR paths must be lowercase.
BUILD_REGISTRY=$(printf '%s' "${BUILD_REGISTRY}" | tr '[:upper:]' '[:lower:]')
SETTINGS_NAME="radius-recipe-registry"
SECRET_NAME="radius-recipe-registry"

fail() {
  echo "::error::$1" >&2
  exit 1
}

[[ "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || fail "AWS_ACCOUNT_ID \"${AWS_ACCOUNT_ID}\" is not a 12-digit account ID."
[[ "${AWS_REGION}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] || fail "AWS_REGION \"${AWS_REGION}\" is not an AWS region."
[[ "${EKS_CLUSTER_NAME}" =~ ^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$ ]] || fail "AWS_EKS_CLUSTER_NAME \"${EKS_CLUSTER_NAME}\" is not an EKS cluster name."
[[ "${VPC_ID}" =~ ^vpc-[0-9a-f]+$ ]] || fail "RADIUS_VPC_ID \"${VPC_ID}\" is not a VPC ID."
[[ "${RECIPE_REGISTRY}" =~ ^ghcr\.io/[a-z0-9._/-]+$ ]] || fail "Recipe registry \"${RECIPE_REGISTRY}\" must be a lowercase ghcr.io path."

# RADIUS_SUBNET_IDS is a comma-separated list; a JSON array is accepted too.
if printf '%s' "${SUBNET_IDS}" | jq -e 'type == "array"' >/dev/null 2>&1; then
  SUBNETS_CSV=$(printf '%s' "${SUBNET_IDS}" | jq -r 'map(tostring) | join(",")')
else
  SUBNETS_CSV=$(printf '%s' "${SUBNET_IDS}" | tr -d '[:space:]')
fi
[[ "${SUBNETS_CSV}" =~ ^subnet-[0-9a-f]+(,subnet-[0-9a-f]+)*$ ]] \
  || fail "RADIUS_SUBNET_IDS must list subnet IDs such as subnet-0abc,subnet-0def."

# shellcheck source=/dev/null
source "${RADIUS_CONTRIB_CATALOG_HELPER}"

BICEP_BIN="${BICEP_BIN:-${BICEP:-${HOME}/.rad/bin/bicep}}"
[[ -d "${BICEP_BIN}" ]] && BICEP_BIN="${BICEP_BIN}/bicep"
[[ -x "${BICEP_BIN}" ]] || BICEP_BIN="${HOME}/.rad/bin/rad-bicep"
[[ -x "${BICEP_BIN}" ]] || fail "Bicep compiler not found under ${HOME}/.rad/bin."

WORK=$(mktemp -d "${RUNNER_TEMP:-/tmp}/aws-recipe-pack.XXXXXX")
trap 'rm -rf "${WORK}"' EXIT
cp "${ACTION_PATH}/bicepconfig.json" "${WORK}/bicepconfig.json"

write_environment() {
  cat > "${WORK}/environment.bicep" <<EOF
extension radius

resource env 'Radius.Core/environments@2025-08-01-preview' = {
  name: '${ENVIRONMENT}'
  properties: {
    providers: {
      aws: {
        accountId: '${AWS_ACCOUNT_ID}'
        region: '${AWS_REGION}'
      }
      kubernetes: {
        namespace: '${NAMESPACE}'
      }
    }
  }
}
EOF
}

echo "Creating Radius environment '${ENVIRONMENT}'..."
write_environment
rad deploy "${WORK}/environment.bicep"

# Radius pulls Bicep recipes from GHCR with these credentials. The token is the
# job's GITHUB_TOKEN, so it is rewritten on every deploy.
echo "Configuring recipe registry authentication for ghcr.io..."
cat > "${WORK}/registry.bicep" <<'EOF'
extension radius

param environment string
param secretName string
param settingsName string
@secure()
param username string
@secure()
param password string

resource registrySecret 'Radius.Security/secrets@2025-08-01-preview' = {
  name: secretName
  properties: {
    environment: environment
    data: {
      username: {
        value: username
      }
      password: {
        value: password
      }
    }
  }
}

resource settings 'Radius.Core/bicepSettings@2025-08-01-preview' = {
  name: settingsName
  properties: {
    registryAuthentications: {
      'ghcr.io': {
        authenticationMethod: 'BasicAuth'
        basicAuthSecretId: registrySecret.id
      }
    }
  }
}
EOF
rad deploy "${WORK}/registry.bicep" --environment "${ENVIRONMENT}" \
  --parameters secretName="${SECRET_NAME}" \
  --parameters settingsName="${SETTINGS_NAME}" \
  --parameters username="${REGISTRY_USERNAME}" \
  --parameters password="${REGISTRY_PASSWORD}"

# Radius v0.61.1 reads the secret's backing Kubernetes Secret with the control
# plane's own client, but the secrets recipe writes it to the target cluster.
# Mirror it into the control-plane cluster (kubectl's default context) under the
# same namespace and name so recipe registry auth can load it.
echo "Mirroring registry credentials into the control-plane cluster..."
(
  umask 077
  printf '%s' "${REGISTRY_USERNAME}" > "${WORK}/registry-username"
  printf '%s' "${REGISTRY_PASSWORD}" > "${WORK}/registry-password"
)
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic "${SECRET_NAME}" --namespace "${NAMESPACE}" \
  --from-file=username="${WORK}/registry-username" \
  --from-file=password="${WORK}/registry-password" \
  --dry-run=client -o yaml | kubectl apply -f -
rm -f "${WORK}/registry-username" "${WORK}/registry-password"

cat > "${WORK}/environment.bicep" <<EOF
extension radius

resource settings 'Radius.Core/bicepSettings@2025-08-01-preview' existing = {
  name: '${SETTINGS_NAME}'
}

resource env 'Radius.Core/environments@2025-08-01-preview' = {
  name: '${ENVIRONMENT}'
  properties: {
    bicepSettings: settings.id
    providers: {
      aws: {
        accountId: '${AWS_ACCOUNT_ID}'
        region: '${AWS_REGION}'
      }
      kubernetes: {
        namespace: '${NAMESPACE}'
      }
    }
  }
}
EOF
rad deploy "${WORK}/environment.bicep"
echo "✅ Environment '${ENVIRONMENT}' created."

# Radius resource type served by each recipe file in ./recipes.
declare -A RECIPE_TYPES=(
  [mysql]="Radius.Data/mySqlDatabases"
  [postgresql]="Radius.Data/postgreSqlDatabases"
  [sqlserver]="Radius.Data/sqlServerDatabases"
  [redis]="Radius.Data/redisCaches"
  [mongo]="Radius.Data/mongoDatabases"
  [kafka]="Radius.Messaging/kafka"
  [objectstorage]="Radius.Storage/objectStorage"
  [search]="Radius.AI/search"
  [models]="Radius.AI/models"
)

# Values the pack may pass to a recipe. Each recipe gets exactly the ones it
# declares, because a deployment rejects parameters a template does not define.
AVAILABLE=$(jq -n \
  --arg eksClusterName "${EKS_CLUSTER_NAME}" \
  --arg subnetIds "${SUBNETS_CSV}" \
  --arg vpcId "${VPC_ID}" \
  --arg region "${AWS_REGION}" \
  --arg accountId "${AWS_ACCOUNT_ID}" \
  '$ARGS.named')

AWS_RECIPES='{}'
for name in $(printf '%s\n' "${!RECIPE_TYPES[@]}" | sort); do
  file="${ACTION_PATH}/recipes/${name}.bicep"
  if [[ ! -f "${file}" ]]; then
    echo "No AWS recipe for ${RECIPE_TYPES[${name}]}; leaving it out of the pack."
    continue
  fi
  cp "${file}" "${WORK}/${name}.bicep"
  # Content-addressed tag: an unchanged recipe republishes to the same tag.
  tag=$(cat "${WORK}/${name}.bicep" "${WORK}/bicepconfig.json" | sha256sum | cut -c1-12)
  source_ref="${RECIPE_REGISTRY}/radius-aws-recipes/${name}:${tag}"
  echo "Publishing ${name} recipe to ${source_ref}..."
  rad bicep publish --file "${WORK}/${name}.bicep" --target "br:${source_ref}"
  declared=$("${BICEP_BIN}" build "${WORK}/${name}.bicep" --stdout | jq -c '.parameters | keys')
  AWS_RECIPES=$(jq -c \
    --arg type "${RECIPE_TYPES[${name}]}" \
    --arg source "${source_ref}" \
    --argjson declared "${declared}" \
    --argjson available "${AVAILABLE}" \
    '. + {($type): {
      kind: "bicep",
      source: $source,
      parameters: ($available | with_entries(select(.key as $k | $declared | index($k))))
    }}' <<<"${AWS_RECIPES}")
done

kube_source() {
  radius_contrib_kube_recipe_source "$1" "$2"
}
KUBE_RECIPES=$(jq -n \
  --arg containers "$(kube_source Radius.Compute/containers containers)" \
  --arg volumes "$(kube_source Radius.Compute/persistentVolumes persistentvolumes)" \
  --arg secrets "$(kube_source Radius.Security/secrets secrets)" \
  --arg routes "$(kube_source Radius.Compute/routes routes)" \
  --arg images "$(kube_source Radius.Compute/containerImages containerimages)" \
  --arg rabbitmq "$(kube_source Radius.Messaging/rabbitMQ rabbitmq)" \
  --arg gatewayName "${ROUTES_GATEWAY_NAME}" \
  --arg gatewayNamespace "${ROUTES_GATEWAY_NAMESPACE}" \
  --arg registry "${BUILD_REGISTRY}" \
  --arg registrySecretName "${REGISTRY_SECRET_NAME}" \
  '{
    "Radius.Compute/containers": {kind: "bicep", source: $containers},
    "Radius.Compute/persistentVolumes": {kind: "bicep", source: $volumes},
    "Radius.Security/secrets": {kind: "bicep", source: $secrets},
    "Radius.Messaging/rabbitMQ": {kind: "bicep", source: $rabbitmq},
    "Radius.Compute/routes": {kind: "bicep", source: $routes,
      parameters: {gatewayName: $gatewayName, gatewayNamespace: $gatewayNamespace}},
    "Radius.Compute/containerImages": {kind: "bicep", source: $images,
      parameters: {registry: $registry, registrySecretName: $registrySecretName}}
  }')

jq -n --argjson kube "${KUBE_RECIPES}" --argjson aws "${AWS_RECIPES}" '$kube + $aws' \
  > "${WORK}/recipes.json"
cp "${ACTION_PATH}/aws-recipe-pack.bicep" "${WORK}/aws-recipe-pack.bicep"

echo "AWS recipe pack:"
jq . "${WORK}/recipes.json"
rad deploy "${WORK}/aws-recipe-pack.bicep" --environment "${ENVIRONMENT}" \
  --parameters packName="${PACK_NAME}"
echo "✅ AWS recipe pack deployed."
echo "recipe-pack=${PACK_NAME}" >> "${GITHUB_OUTPUT}"
