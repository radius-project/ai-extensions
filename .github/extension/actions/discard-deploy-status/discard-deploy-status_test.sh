#!/bin/bash

# ============================================================================
# Unit tests for the discard-deploy-status action's script.
#
# `gh` is stubbed by a recorder on PATH: there is no runner, no network and no
# GitHub API. The stub logs every invocation so the tests can assert both that
# the listing is filtered to exactly one artifact name and that only the ids it
# returned are deleted.
#
# The action.yml wiring the script cannot cover -- the step's env mapping and
# the `run:` line -- is checked structurally against the file instead; nothing
# else covers it.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly TARGET="${SCRIPT_DIR}/discard-deploy-status.sh"
readonly ACTION_FILE="${SCRIPT_DIR}/action.yml"
readonly PROGRESS_HELPER="${SCRIPT_DIR}/../deploy-progress/progress.sh"

TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

readonly STUB_BIN="${TEST_ROOT}/bin"
GH_CALL_LOG="${TEST_ROOT}/gh-calls.log"
export GH_CALL_LOG
mkdir -p "${STUB_BIN}"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "ok - $*"
}

assert_contains() {
    local haystack="$1" needle="$2" label="$3"
    case "${haystack}" in
    *"${needle}"*) ;;
    *) fail "${label}: expected to find '${needle}' in:
${haystack}" ;;
    esac
}

assert_not_contains() {
    local haystack="$1" needle="$2" label="$3"
    case "${haystack}" in
    *"${needle}"*) fail "${label}: did not expect '${needle}' in:
${haystack}" ;;
    esac
}

assert_equals() {
    local actual="$1" expected="$2" label="$3"
    [[ "${actual}" == "${expected}" ]] ||
        fail "${label}: expected '${expected}', got '${actual}'"
}

# ---------------------------------------------------------------------------
# `gh` recorder. Behaviour is driven entirely by environment variables so each
# case can model one API outcome without editing the stub.
# ---------------------------------------------------------------------------
cat >"${STUB_BIN}/gh" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >>"${GH_CALL_LOG}"
for arg in "$@"; do
    if [ "${arg}" = "DELETE" ]; then
        artifact_id=""
        for candidate in "$@"; do
            case "${candidate}" in
            */actions/artifacts/*) artifact_id="${candidate##*/}" ;;
            esac
        done
        case " ${GH_DELETE_FAIL_IDS:-} " in
        *" ${artifact_id} "*)
            printf 'HTTP 403: Resource not accessible by integration\n' >&2
            exit 1
            ;;
        esac
        exit 0
    fi
done
if [ "${GH_LIST_EXIT:-0}" != "0" ]; then
    printf '%b' "${GH_LIST_ERROR:-listing failed}" >&2
    exit "${GH_LIST_EXIT}"
fi
printf '%s' "${GH_LIST_OUTPUT:-}"
STUB
chmod +x "${STUB_BIN}/gh"

# ---------------------------------------------------------------------------
# Run the script under test with a clean call log. Echoes its combined output;
# the caller reads the exit code from RUN_EXIT.
# ---------------------------------------------------------------------------
RUN_EXIT=0
run_script() {
    : >"${GH_CALL_LOG}"
    RUN_EXIT=0
    PATH="${STUB_BIN}:${PATH}" bash "${TARGET}" 2>&1 || RUN_EXIT=$?
}

gh_calls() {
    cat "${GH_CALL_LOG}"
}

delete_call_count() {
    grep -c -- "--method DELETE" "${GH_CALL_LOG}" || true
}

# The name the producer and the canvas reader derive for the same pair. Sourced
# rather than restated so the test cannot drift from the shared helper.
# shellcheck source=/dev/null disable=SC1091
source "${PROGRESS_HELPER}"

# ---------------------------------------------------------------------------
# Deletes exactly the artifacts named for this (environment, application) pair.
# ---------------------------------------------------------------------------
expected_name="$(radius_deploy_artifact_name "prod" "billing")"
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT=$'11\n12\n' \
        run_script
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "successful run exits 0"
calls="$(gh_calls)"
assert_contains "${calls}" "-f name=${expected_name}" "listing filters on the exact artifact name"
assert_contains "${calls}" "repos/acme/shop/actions/artifacts" "listing targets the workflow repository"
assert_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/11" "deletes the first listed artifact"
assert_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/12" "deletes the second listed artifact"
assert_equals "$(delete_call_count)" "2" "deletes only the listed artifacts"
assert_contains "${output}" "Removed 2 '${expected_name}' artifact(s)" "reports how many were removed"
pass "removes every artifact published under this environment and application"

# ---------------------------------------------------------------------------
# The name is scoped to the pair: a different application in the same
# environment, and the same application in another environment, are filtered
# out by the listing rather than deleted.
# ---------------------------------------------------------------------------
other_app="$(radius_deploy_artifact_name "prod" "checkout")"
other_env="$(radius_deploy_artifact_name "staging" "billing")"
[[ "${expected_name}" != "${other_app}" ]] ||
    fail "another application in the same environment must derive a different name"
[[ "${expected_name}" != "${other_env}" ]] ||
    fail "the same application in another environment must derive a different name"
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT=$'11\n' \
        run_script
)"
calls="$(gh_calls)"
assert_not_contains "${calls}" "${other_app}" "never lists another application's artifacts"
assert_not_contains "${calls}" "${other_env}" "never lists another environment's artifacts"
pass "scopes the deletion to one application in one environment"

# ---------------------------------------------------------------------------
# Messy names go through the shared sanitizer, so the script asks for the same
# name the producer uploaded.
# ---------------------------------------------------------------------------
messy_name="$(radius_deploy_artifact_name "Prod EU" "Café™ App")"
output="$(
    ENVIRONMENT="Prod EU" APPLICATION="Café™ App" GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT="" \
        run_script
)"
assert_contains "$(gh_calls)" "-f name=${messy_name}" "sanitizes the name with the shared helper"
assert_contains "${messy_name}" "radius-deploy-status-prod-eu-caf" "sanitized name is lowercase and ASCII"
pass "derives the artifact name with the producer's sanitizer"

# ---------------------------------------------------------------------------
# Nothing to remove: no delete is attempted and the run still succeeds.
# ---------------------------------------------------------------------------
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT="" \
        run_script
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "an empty listing exits 0"
assert_equals "$(delete_call_count)" "0" "an empty listing deletes nothing"
assert_contains "${output}" "No '${expected_name}' artifacts to remove." "reports that there was nothing to remove"
pass "handles an environment and application with no published deployment"

# ---------------------------------------------------------------------------
# Only well-formed artifact ids are ever interpolated into a request path.
# ---------------------------------------------------------------------------
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT=$'\n42\nnot-an-id\n../../evil\n' \
        run_script
)"
assert_equals "$(delete_call_count)" "1" "skips every listing line that is not an artifact id"
assert_contains "$(gh_calls)" "actions/artifacts/42" "still deletes the well-formed id"
assert_not_contains "$(gh_calls)" "evil" "never puts an unparsable id in the request path"
pass "ignores malformed artifact ids in the listing"

# ---------------------------------------------------------------------------
# Best-effort: a listing failure warns and leaves the workflow green.
# ---------------------------------------------------------------------------
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_EXIT=1 GH_LIST_ERROR='HTTP 403: Resource not accessible' \
        run_script
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "a listing failure does not fail the delete workflow"
assert_contains "${output}" "::warning::Deployed graph cleanup: could not list '${expected_name}' artifacts" "warns about the listing failure"
assert_contains "${output}" "HTTP 403: Resource not accessible" "surfaces the API error text"
assert_equals "$(delete_call_count)" "0" "does not attempt a delete after a failed listing"
pass "survives a failed artifact listing"

# ---------------------------------------------------------------------------
# A newline in an API error body cannot start a new log line, so it cannot
# inject a workflow command.
# ---------------------------------------------------------------------------
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_EXIT=1 GH_LIST_ERROR='boom\n::error::injected' \
        run_script
)"
assert_contains "${output}" "boom::error::injected" "control characters are stripped from the error body"
assert_not_contains "${output}" $'\n::error::injected' "an error body cannot start a new log line"
pass "strips control characters from API error text"

# ---------------------------------------------------------------------------
# A partial failure is reported without failing the workflow, and the artifacts
# that can be deleted still are.
# ---------------------------------------------------------------------------
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT=$'11\n12\n' GH_DELETE_FAIL_IDS='11' \
        run_script
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "a delete failure does not fail the delete workflow"
assert_contains "${output}" "::warning::Deployed graph cleanup: could not delete artifact 11" "warns about the artifact it could not delete"
assert_contains "${output}" "removed 1 of 2 '${expected_name}' artifacts" "reports the partial outcome"
assert_equals "$(delete_call_count)" "2" "still attempts the remaining artifacts"
pass "continues past an artifact it cannot delete"

# ---------------------------------------------------------------------------
# Missing identity fails closed: without both names there is no artifact this
# script can claim to own, so it touches nothing.
# ---------------------------------------------------------------------------
for case_label in "empty environment" "blank environment" "empty application" "blank application" "empty repository"; do
    case "${case_label}" in
    "empty environment") env_value=""; app_value="billing"; repo_value="acme/shop" ;;
    "blank environment") env_value="   "; app_value="billing"; repo_value="acme/shop" ;;
    "empty application") env_value="prod"; app_value=""; repo_value="acme/shop" ;;
    "blank application") env_value="prod"; app_value=$'\t'; repo_value="acme/shop" ;;
    "empty repository") env_value="prod"; app_value="billing"; repo_value="" ;;
    esac
    output="$(
        ENVIRONMENT="${env_value}" APPLICATION="${app_value}" GITHUB_REPOSITORY="${repo_value}" \
            run_script
        echo "__exit__${RUN_EXIT}"
    )"
    assert_contains "${output}" "__exit__0" "${case_label}: exits 0"
    assert_contains "${output}" "::warning::Deployed graph cleanup:" "${case_label}: warns"
    assert_contains "${output}" "nothing to remove." "${case_label}: says nothing was removed"
    assert_equals "$(wc -l <"${GH_CALL_LOG}" | tr -d ' ')" "0" "${case_label}: makes no API call"
done
pass "makes no API call when the environment, application or repository is missing"

# ---------------------------------------------------------------------------
# action.yml wiring the script cannot exercise.
# ---------------------------------------------------------------------------
action_text="$(cat "${ACTION_FILE}")"
# Literal GitHub Actions expressions and a literal runner variable, not shell
# expansions, so they are single-quoted on purpose.
# shellcheck disable=SC2016
action_wiring=(
    'ENVIRONMENT: ${{ inputs.environment }}'
    'APPLICATION: ${{ inputs.application }}'
    'GH_TOKEN: ${{ inputs.github-token }}'
    'run: bash "$GITHUB_ACTION_PATH/discard-deploy-status.sh"'
    'using: composite'
)
for needle in "${action_wiring[@]}"; do
    assert_contains "${action_text}" "${needle}" "action.yml is missing its wiring"
done
pass "action.yml wires its inputs into the script"

echo "All discard-deploy-status tests passed."
