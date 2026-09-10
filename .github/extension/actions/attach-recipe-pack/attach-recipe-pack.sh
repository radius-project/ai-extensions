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

echo "Reading recipe packs attached to environment '${ENVIRONMENT}'..."
if ! EXISTING_PACKS="$(
    rad env show "${ENVIRONMENT}" --preview -o json |
        jq -sce '
          if length == 0 or (.[0] | type) != "object" then
            error("environment response must begin with an object")
          elif (.[0].properties.recipePacks | type) != "array" then
            error("environment recipePacks must be an array")
          elif any(
            .[0].properties.recipePacks[];
            type != "string" or length == 0
          ) then
            error("environment recipePacks must contain non-empty strings")
          else
            .[0].properties.recipePacks
          end
        '
)"; then
    echo "ERROR: Environment '${ENVIRONMENT}' returned invalid recipe-pack data." >&2
    exit 1
fi

PACK_IDS="$(
    jq -nr \
        --argjson existing "${EXISTING_PACKS}" \
        --arg provider "${PACK_ID}" '
          reduce ($existing + [$provider])[] as $id
            ([]; if index($id) then . else . + [$id] end) |
          join(",")
        '
)"

echo "Attaching recipe packs '${PACK_IDS}' to environment '${ENVIRONMENT}'..."
rad env update "${ENVIRONMENT}" --recipe-packs "${PACK_IDS}" --preview
echo "✅ Environment '${ENVIRONMENT}' attached to provider recipe pack."
