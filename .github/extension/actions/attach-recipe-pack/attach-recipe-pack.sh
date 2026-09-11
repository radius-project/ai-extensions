#!/usr/bin/env bash

set -euo pipefail

[[ -n "${ENVIRONMENT:-}" ]] || {
    echo "ERROR: Radius environment name is required." >&2
    exit 1
}
if [[ -n "${RECIPE_PACKS_JSON:-}" ]]; then
    if ! RECIPE_PACK_NAMES="$(
        jq -cer '
          select(type == "array" and length > 0) |
          select(all(.[]; type == "string" and length > 0)) |
          unique
        ' <<<"${RECIPE_PACKS_JSON}"
    )"; then
        echo "ERROR: Recipe pack names must be a non-empty JSON array of non-empty strings." >&2
        exit 1
    fi
elif [[ -n "${RECIPE_PACK:-}" ]]; then
    RECIPE_PACK_NAMES="$(jq -nc --arg pack "${RECIPE_PACK}" '[$pack]')"
else
    echo "ERROR: Recipe pack name is required." >&2
    exit 1
fi

RESOLVED_PACKS='[]'
while IFS= read -r pack_name; do
    echo "Resolving recipe pack '${pack_name}'..."
    PACK_JSON="$(rad recipe-pack show "${pack_name}" -o json)"
    if ! PACK_ID="$(
        jq -er '.id | select(type == "string" and length > 0)' <<<"${PACK_JSON}"
    )"; then
        echo "ERROR: Recipe pack '${pack_name}' returned an invalid resource ID." >&2
        exit 1
    fi
    RESOLVED_PACKS="$(
        jq -nc \
            --argjson packs "${RESOLVED_PACKS}" \
            --arg id "${PACK_ID}" \
            '$packs + [$id]'
    )"
done < <(jq -r '.[]' <<<"${RECIPE_PACK_NAMES}")

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
        --argjson resolved "${RESOLVED_PACKS}" '
          reduce ($existing + $resolved)[] as $id
            ([]; if index($id) then . else . + [$id] end) |
          join(",")
        '
)"

echo "Attaching recipe packs '${PACK_IDS}' to environment '${ENVIRONMENT}'..."
rad env update "${ENVIRONMENT}" --recipe-packs "${PACK_IDS}" --preview
echo "✅ Environment '${ENVIRONMENT}' updated with recipe packs."
