#!/usr/bin/env bash

set -euo pipefail

# The override is one environment-scoped value so the release identity and
# installer checksum cannot be selected independently.
if [[ -n "${RADIUS_RELEASE_OVERRIDE:-}" ]]; then
    jq -se '
        length == 1 and (.[0] |
        type == "object" and
        (.tag | type == "string" and test("^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?\\z")) and
        (.commit | type == "string" and test("^[0-9a-f]{40}\\z")) and
        (.checksum | type == "string" and test("^[0-9a-f]{64}\\z")))
    ' <<<"${RADIUS_RELEASE_OVERRIDE}" >/dev/null || {
        echo "::error::RADIUS_RELEASE_OVERRIDE must contain a release tag, a 40-character commit, and a 64-character installer checksum." >&2
        exit 1
    }
    RADIUS_INSTALL_REF="$(jq -r .tag <<<"${RADIUS_RELEASE_OVERRIDE}")"
    RADIUS_INSTALL_COMMIT="$(jq -r .commit <<<"${RADIUS_RELEASE_OVERRIDE}")"
    RADIUS_INSTALL_SHA256="$(jq -r .checksum <<<"${RADIUS_RELEASE_OVERRIDE}")"
fi

installer="$(mktemp)"
trap 'rm -f "${installer}"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-connrefused \
    "https://raw.githubusercontent.com/radius-project/radius/${RADIUS_INSTALL_COMMIT}/deploy/install.sh" \
    -o "${installer}"
echo "${RADIUS_INSTALL_SHA256}  ${installer}" | sha256sum -c -
/bin/bash "${installer}" --version "${RADIUS_INSTALL_REF}"
rad version

# Later actions must use the same immutable catalog as the installed CLI.
printf 'RADIUS_INSTALL_COMMIT=%s\n' "${RADIUS_INSTALL_COMMIT}" >>"${GITHUB_ENV}"
