#!/bin/bash

# Prints the Radius ref to fetch the contrib catalog from.
#
# Usage: resolve-catalog-ref.sh <requested-ref> [control-plane-action.yml]
#
# A non-empty requested ref wins. Otherwise the ref is the RADIUS_INSTALL_REF
# pinned by the sibling setup-control-plane action, so the catalog comes from the
# same Radius release the control plane installs.

set -euo pipefail

requested="${1:-}"
if [ -n "$requested" ]; then
    printf '%s\n' "$requested"
    exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
control_plane_action="${2:-${script_dir}/../setup-control-plane/action.yml}"

ref=""
if [ -f "$control_plane_action" ]; then
    ref="$(sed -nE 's/^[[:space:]]+RADIUS_INSTALL_REF: ([^[:space:]]+)$/\1/p' "$control_plane_action")"
fi
if [ -z "$ref" ]; then
    echo "::error::Could not read RADIUS_INSTALL_REF from ${control_plane_action}" >&2
    exit 1
fi
printf '%s\n' "$ref"
