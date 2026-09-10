#!/usr/bin/env bash

set -euo pipefail

[[ -n "${ENVIRONMENT:-}" ]] || {
    echo "ERROR: Radius environment name is required." >&2
    exit 1
}
[[ -n "${RECIPE_PACK:-}" ]] || {
    echo "ERROR: Recipe pack name is required." >&2
    exit 1
}

echo "Resolving provider recipe pack '${RECIPE_PACK}'..."
PACK_JSON="$(rad recipe-pack show "${RECIPE_PACK}" -o json)"
if ! PACK_ID="$(
    jq -er '.id | select(type == "string" and length > 0)' <<<"${PACK_JSON}"
)"; then
    echo "ERROR: Recipe pack '${RECIPE_PACK}' returned an invalid resource ID." >&2
    exit 1
fi

echo "Attaching recipe pack '${PACK_ID}' to environment '${ENVIRONMENT}'..."
rad env update "${ENVIRONMENT}" --recipe-packs "${PACK_ID}" --preview
echo "✅ Environment '${ENVIRONMENT}' attached to provider recipe pack."
