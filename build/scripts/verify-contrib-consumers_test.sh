#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly VERIFIER="${SCRIPT_DIR}/verify-contrib-consumers.sh"
readonly HELPER_PATH="${REPO_ROOT}/.github/extension/scripts/contrib-catalog.sh"
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

run_source_check() {
    local extension_dir="$1"
    EXTENSION_DIR="${extension_dir}" \
        bash "${VERIFIER}" --source-of-truth-only >/dev/null
}

run_source_check "${REPO_ROOT}/.github/extension"

mkdir -p "${TEST_ROOT}/policy"
cat >"${TEST_ROOT}/policy/good.yml" <<'YAML'
---
name: good
jobs:
  verify:
    steps:
      - run: echo catalog
YAML
run_source_check "${TEST_ROOT}/policy"

cat >"${TEST_ROOT}/policy/bad.yml" <<'YAML'
---
name: bad
jobs:
  verify:
    steps:
      - run: curl https://github.com/radius-project/resource-types-contrib
YAML
if run_source_check "${TEST_ROOT}/policy" 2>/dev/null; then
    fail "source-of-truth check accepted a direct contrib source"
fi

cat >"${TEST_ROOT}/policy/bad.yml" <<'YAML'
---
name: bad
env:
  RADIUS_INSTALL_REF: f4b44130e6ccbf52405fcfba59b24912aa45eeb8
jobs: {}
YAML
if run_source_check "${TEST_ROOT}/policy" 2>/dev/null; then
    fail "source-of-truth check accepted a full installer commit SHA"
fi

cat >"${TEST_ROOT}/policy/bad.yml" <<'YAML'
---
name: bad
jobs:
  verify:
    steps:
      - run: echo ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD
YAML
if run_source_check "${TEST_ROOT}/policy" 2>/dev/null; then
    fail "source-of-truth check accepted a SHA in a run block"
fi
rm "${TEST_ROOT}/policy/bad.yml"

mkdir -p "${TEST_ROOT}/extension" "${TEST_ROOT}/bin" "${TEST_ROOT}/tmp"
cat >"${TEST_ROOT}/extension/workflow.yml" <<'YAML'
---
name: verifier fixture
jobs:
  verify:
    steps:
      - run: |
          PACK_NAME="sample"
          radius_contrib_recipe_pack_url sample pack.bicep
          radius_contrib_kube_recipe_source Radius.Test/widgets widgets
          radius_contrib_resource_git_source Radius.Test/widgets recipes/terraform
          PACK_PARAMETERS=(
            --parameters routesGatewayName="$ROUTES_GATEWAY_NAME"
          )
          PACK_PARAMETERS+=(
            --parameters appendedParam="x"
          )
          PACK_PARAMETERS+=(--parameters "inlineParam=x")
          echo "--parameters notAPackParameter=ignored"
          rad deploy "$RECIPE_PACK_BICEP" "${PACK_PARAMETERS[@]}"
YAML

cat >"${TEST_ROOT}/bin/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${CURL_LOG}"
output=""
url=""
while (($#)); do
    case "$1" in
        -o)
            output="$2"
            shift 2
            ;;
        http*)
            url="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done
[[ -n "${output}" && -n "${url}" ]]
if [[ "${FAIL_CATALOG_FETCH:-}" == true && "${url}" == */deploy/manifest/defaults.yaml ]]; then
    exit 22
fi
if [[ "${output}" == /dev/null ]]; then
    exit 0
fi
if [[ "${url}" == */deploy/manifest/defaults.yaml ]]; then
    cat >"${output}" <<'YAML'
resourceTypes:
  - name: Radius.Test
    repo: github.com/example/resource-types
    ref: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
recipePacks:
  - name: sample
    repo: github.com/example/resource-types
    ref: cccccccccccccccccccccccccccccccccccccccc
YAML
else
    cat >"${output}" <<BICEP
param ${PACK_DECLARED_PARAMETER:-routesGatewayName} string
param ${PACK_APPENDED_PARAMETER:-appendedParam} string
param ${PACK_INLINE_PARAMETER:-inlineParam} string
resource pack 'Radius.Core/recipePacks@2025-08-01-preview' = {
  name: '${PACK_DECLARED_NAME:-sample}'
  properties: {
    recipes: {
      'Radius.Test/widgets': {
        kind: 'bicep'
        source: 'ghcr.io/radius-project/kube-recipes/widgets:latest'
      }
    }
  }
}
BICEP
fi
BASH

cat >"${TEST_ROOT}/bin/docker" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${DOCKER_LOG}"
[[ "$1 $2" == "manifest inspect" ]]
BASH

cat >"${TEST_ROOT}/bin/git" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == init ]]; then
    mkdir -p "$3"
    exit 0
fi
if [[ "$1" == -C && "$3" == checkout ]]; then
    mkdir -p "$2/Test/widgets/recipes/terraform"
fi
BASH
chmod +x "${TEST_ROOT}/bin/curl" "${TEST_ROOT}/bin/docker" "${TEST_ROOT}/bin/git"

export CURL_LOG="${TEST_ROOT}/curl.log"
export DOCKER_LOG="${TEST_ROOT}/docker.log"
export TMPDIR="${TEST_ROOT}/tmp"
readonly REF="dddddddddddddddddddddddddddddddddddddddd"

if PATH="${TEST_ROOT}/bin:${PATH}" \
    CATALOG_REF=main \
    CATALOG_HELPER="${HELPER_PATH}" \
    EXTENSION_DIR="${TEST_ROOT}/extension" \
    bash "${VERIFIER}" >/dev/null 2>&1; then
    fail "verifier accepted a mutable catalog ref"
fi

if PATH="${TEST_ROOT}/bin:${PATH}" \
    FAIL_CATALOG_FETCH=true \
    CATALOG_REF="${REF}" \
    CATALOG_HELPER="${HELPER_PATH}" \
    EXTENSION_DIR="${TEST_ROOT}/extension" \
    bash "${VERIFIER}" >/dev/null 2>&1; then
    fail "verifier ignored a catalog fetch failure"
fi

: >"${CURL_LOG}"
: >"${DOCKER_LOG}"
PATH="${TEST_ROOT}/bin:${PATH}" \
    CATALOG_REF="${REF}" \
    CATALOG_HELPER="${HELPER_PATH}" \
    EXTENSION_DIR="${TEST_ROOT}/extension" \
    bash "${VERIFIER}" >/dev/null

grep -Fq "radius-project/radius/${REF}/deploy/manifest/defaults.yaml" "${CURL_LOG}" ||
    fail "verifier did not fetch defaults.yaml at the immutable catalog ref"
grep -Fq "manifest inspect ghcr.io/radius-project/kube-recipes/widgets:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "${DOCKER_LOG}" ||
    fail "verifier did not inspect the catalog-pinned OCI recipe"
[[ "$(grep -c '/recipe-packs/sample/pack.bicep' "${CURL_LOG}")" -eq 1 ]] ||
    fail "verifier downloaded the recipe pack more than once"
if find "${TEST_ROOT}/tmp" -mindepth 1 -print -quit | grep -q .; then
    fail "verifier leaked its temporary checkout or catalog"
fi

# A pack that no longer declares the name the workflow attaches would otherwise
# only fail at deploy time, when `rad recipe-pack show` cannot resolve it.
: >"${CURL_LOG}"
: >"${DOCKER_LOG}"
if PATH="${TEST_ROOT}/bin:${PATH}" \
    PACK_DECLARED_NAME=renamed \
    CATALOG_REF="${REF}" \
    CATALOG_HELPER="${HELPER_PATH}" \
    EXTENSION_DIR="${TEST_ROOT}/extension" \
    bash "${VERIFIER}" >/dev/null 2>&1; then
    fail "verifier accepted a pack that does not declare the attached pack name"
fi

# A pack that no longer declares a parameter the workflow passes would otherwise
# only fail at deploy time, when `rad deploy` rejects the unknown parameter.
: >"${CURL_LOG}"
: >"${DOCKER_LOG}"
if PATH="${TEST_ROOT}/bin:${PATH}" \
    PACK_DECLARED_PARAMETER=renamedGatewayName \
    CATALOG_REF="${REF}" \
    CATALOG_HELPER="${HELPER_PATH}" \
    EXTENSION_DIR="${TEST_ROOT}/extension" \
    bash "${VERIFIER}" >/dev/null 2>&1; then
    fail "verifier accepted a pack that does not declare a passed parameter"
fi

# Parameters appended to the array after it is declared must be verified too. A
# resurrected compatibility shim would use exactly these shapes, so a gap here
# would let it pass unverified. Each case fails only if the parameter is
# captured, so a regression in capture turns into a test failure.
: >"${CURL_LOG}"
: >"${DOCKER_LOG}"
if PATH="${TEST_ROOT}/bin:${PATH}" \
    PACK_APPENDED_PARAMETER=renamedAppendedParam \
    CATALOG_REF="${REF}" \
    CATALOG_HELPER="${HELPER_PATH}" \
    EXTENSION_DIR="${TEST_ROOT}/extension" \
    bash "${VERIFIER}" >/dev/null 2>&1; then
    fail "verifier ignored a parameter appended by a multi-line PACK_PARAMETERS+=()"
fi

: >"${CURL_LOG}"
: >"${DOCKER_LOG}"
if PATH="${TEST_ROOT}/bin:${PATH}" \
    PACK_INLINE_PARAMETER=renamedInlineParam \
    CATALOG_REF="${REF}" \
    CATALOG_HELPER="${HELPER_PATH}" \
    EXTENSION_DIR="${TEST_ROOT}/extension" \
    bash "${VERIFIER}" >/dev/null 2>&1; then
    fail "verifier ignored a parameter appended by a single-line PACK_PARAMETERS+=()"
fi

echo "contrib consumer verifier tests passed"
