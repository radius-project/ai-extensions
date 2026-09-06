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
GH_ZIP_DIR="${TEST_ROOT}/zips"
export GH_ZIP_DIR
mkdir -p "${STUB_BIN}" "${GH_ZIP_DIR}"

# Writes the artifact payload the script downloads to confirm what an artifact
# describes. `deploy-state.txt` is reproduced exactly as the producer writes it,
# including the raw, unsanitized names.
write_artifact_zip() {
    local zip_path="$1" application="$2" environment="$3"
    python3 - "${zip_path}" "${application}" "${environment}" <<'PY'
import sys, zipfile

zip_path, application, environment = sys.argv[1:4]
state = (
    "state=success\nexitCode=0\n"
    f"application={application}\nenvironment={environment}\n"
    "updatedAt=2024-01-01T00:00:00Z\nsha=abc123\n"
)
with zipfile.ZipFile(zip_path, "w") as archive:
    archive.writestr("deploy-state.txt", state)
    archive.writestr("deploy-graph.json", '{"resources":[]}')
PY
}

# Declares which pair a given artifact id claims to belong to. Ids left
# unregistered are served as belonging to the pair under deletion, so a test
# only has to speak up when it wants a mismatch.
register_artifact_identity() {
    write_artifact_zip "${GH_ZIP_DIR}/$1.zip" "$2" "$3"
}

# An artifact with no `deploy-state.txt`, as uploaded before the producer
# recorded an identity.
register_artifact_without_state() {
    python3 - "${GH_ZIP_DIR}/$1.zip" <<'PY'
import sys, zipfile

with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("deploy-graph.json", '{"resources":[]}')
PY
}

reset_artifact_identities() {
    rm -f "${GH_ZIP_DIR}"/*.zip
}

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
    case "${arg}" in
    */actions/artifacts/*/zip)
        artifact_id="${arg%/zip}"
        artifact_id="${artifact_id##*/}"
        case " ${GH_ZIP_FAIL_IDS:-} " in
        *" ${artifact_id} "*)
            printf 'HTTP 410: Artifact has expired\n' >&2
            exit 1
            ;;
        esac
        prepared="${GH_ZIP_DIR}/${artifact_id}.zip"
        if [ ! -f "${prepared}" ]; then
            # Unregistered ids belong to the pair being deleted. Regenerated on
            # every call so a previous case's pair cannot leak into this one.
            prepared="${GH_ZIP_DIR}/auto-${artifact_id}.zip"
            python3 - "${prepared}" "${APPLICATION}" "${ENVIRONMENT}" <<'PY'
import sys, zipfile

zip_path, application, environment = sys.argv[1:4]
with zipfile.ZipFile(zip_path, "w") as archive:
    archive.writestr(
        "deploy-state.txt",
        f"state=success\nexitCode=0\napplication={application}\n"
        f"environment={environment}\nupdatedAt=now\nsha=abc123\n",
    )
PY
        fi
        cat "${prepared}"
        exit 0
        ;;
    esac
done
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
# Names collide: the sanitizer maps several distinct pairs onto one artifact
# name, so the name alone cannot authorize a delete. Identity is confirmed from
# the payload, per segment, against the same notion of identity the canvas
# reader uses -- so a case variant of this pair goes (the reader would still
# render it) while a genuinely different pair that merely collides stays.
# ---------------------------------------------------------------------------
colliding_name="$(radius_deploy_artifact_name "prod" "billing-east")"
assert_equals "$(radius_deploy_artifact_name "prod-billing" "east")" "${colliding_name}" \
    "distinct pairs really do collide on one artifact name"
reset_artifact_identities
register_artifact_identity 21 "billing-east" "prod"
register_artifact_identity 22 "east" "prod-billing"
register_artifact_identity 23 "Billing-East" "Prod"
output="$(
    ENVIRONMENT=prod APPLICATION=billing-east GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT=$'21\n22\n23\n' \
        run_script
    echo "__exit__${RUN_EXIT}"
)"
calls="$(gh_calls)"
assert_contains "${output}" "__exit__0" "a collision does not fail the delete workflow"
assert_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/21" "deletes the artifact that records this pair"
assert_not_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/22" "keeps a colliding artifact belonging to a genuinely different pair"
assert_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/23" "deletes a case variant of this pair, which the reader would still render"
assert_equals "$(delete_call_count)" "2" "deletes only the artifacts that describe this deployment"
pass "never deletes another application's artifact that collides on the same name"

# ---------------------------------------------------------------------------
# Identity is matched the way the canvas reader matches it: per segment, after
# sanitization. Anything it would still render for this pair has to go, or the
# Deployed graph stays stale -- which is the bug this action exists to fix.
# ---------------------------------------------------------------------------
reset_artifact_identities
register_artifact_identity 51 "Billing East" "PROD"
register_artifact_identity 52 "billing/east" "prod"
register_artifact_identity 53 "billing-west" "prod"
output="$(
    ENVIRONMENT=prod APPLICATION=billing-east GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT=$'51\n52\n53\n' \
        run_script
)"
calls="$(gh_calls)"
assert_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/51" "deletes an artifact whose raw names differ by case and separator"
assert_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/52" "deletes an artifact whose raw name sanitizes to this application"
assert_not_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/53" "keeps a different application in the same environment"
pass "matches identity the way the canvas reader does"

# ---------------------------------------------------------------------------
# Fails closed on an unconfirmable artifact: an unreadable payload is left in
# place to expire rather than deleted on the strength of a colliding name.
# ---------------------------------------------------------------------------
reset_artifact_identities
register_artifact_without_state 31
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT=$'31\n' \
        run_script
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "an unconfirmable artifact does not fail the delete workflow"
assert_equals "$(delete_call_count)" "0" "does not delete an artifact that records no identity"
assert_contains "${output}" "::warning::Deployed graph cleanup: artifact 31 has no readable deploy-state.txt" "warns that the artifact was left in place"
assert_contains "${output}" "none of the 1 '${expected_name}' artifact(s) could be confirmed" "reports that nothing was removed"
pass "leaves an artifact in place when its payload records no identity"

# ---------------------------------------------------------------------------
# The same applies when the payload cannot be fetched at all.
# ---------------------------------------------------------------------------
reset_artifact_identities
output="$(
    ENVIRONMENT=prod APPLICATION=billing GITHUB_REPOSITORY=acme/shop \
        GH_LIST_OUTPUT=$'41\n42\n' GH_ZIP_FAIL_IDS='41' \
        run_script
    echo "__exit__${RUN_EXIT}"
)"
calls="$(gh_calls)"
assert_contains "${output}" "__exit__0" "a download failure does not fail the delete workflow"
assert_not_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/41" "keeps the artifact it could not download"
assert_contains "${calls}" "--method DELETE repos/acme/shop/actions/artifacts/42" "still removes the artifact it could confirm"
assert_contains "${output}" "could not download artifact 41" "warns about the download failure"
assert_contains "${output}" "HTTP 410: Artifact has expired" "surfaces the API error text"
pass "leaves an artifact in place when its payload cannot be downloaded"

reset_artifact_identities

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
# Fails closed when the shared derivation is unavailable. An empty `name=` is
# treated by the REST API as "no filter" and lists the repository's entire
# artifact history, so a run that cannot derive its exact name must make no API
# call at all rather than delete another application's artifacts.
# ---------------------------------------------------------------------------
readonly ISOLATED_ROOT="${TEST_ROOT}/isolated"
mkdir -p "${ISOLATED_ROOT}/action" "${ISOLATED_ROOT}/deploy-progress"
cp "${TARGET}" "${ISOLATED_ROOT}/action/discard-deploy-status.sh"

run_isolated() {
    : >"${GH_CALL_LOG}"
    RUN_EXIT=0
    ENVIRONMENT="prod" APPLICATION="billing" \
        GITHUB_REPOSITORY="octo/repo" \
        PATH="${STUB_BIN}:${PATH}" \
        bash "${ISOLATED_ROOT}/action/discard-deploy-status.sh" 2>&1 || RUN_EXIT=$?
}

# The helper file does not exist at all: `source` fails.
output="$(
    run_isolated
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "unreadable helper file: exits 0"
assert_contains "${output}" "::warning::Deployed graph cleanup:" "unreadable helper file: warns"
assert_contains "${output}" "nothing to remove." "unreadable helper file: removes nothing"
assert_equals "$(wc -l <"${GH_CALL_LOG}" | tr -d ' ')" "0" \
    "unreadable helper file: makes no API call"
pass "makes no API call when the shared helper file is unreadable"

# The helper file loads but does not define the derivation.
printf '#!/bin/bash\n# no radius_deploy_artifact_name here\n' \
    >"${ISOLATED_ROOT}/deploy-progress/progress.sh"
output="$(
    run_isolated
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "helper without the function: exits 0"
assert_contains "${output}" "radius_deploy_artifact_name helper is unavailable" \
    "helper without the function: names the missing helper"
assert_equals "$(wc -l <"${GH_CALL_LOG}" | tr -d ' ')" "0" \
    "helper without the function: makes no API call"
pass "makes no API call when the shared helper does not define the derivation"

# The helper defines the derivation but not the identity comparison. Without it
# the script cannot tell which artifacts describe this pair, so it must not
# delete on the strength of the name alone.
printf '#!/bin/bash\nradius_deploy_artifact_name() { printf "radius-deploy-status-prod-billing"; }\n' \
    >"${ISOLATED_ROOT}/deploy-progress/progress.sh"
output="$(
    run_isolated
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "helper without the segment sanitizer: exits 0"
assert_contains "${output}" "radius_deploy_identity_segment helper is unavailable" \
    "helper without the segment sanitizer: names the missing helper"
assert_equals "$(wc -l <"${GH_CALL_LOG}" | tr -d ' ')" "0" \
    "helper without the segment sanitizer: makes no API call"
pass "makes no API call when the shared helper cannot compare identities"

# The derivation exists but yields an empty name.
printf '#!/bin/bash\nradius_deploy_artifact_name() { printf "%%s" ""; }\nradius_deploy_identity_segment() { :; }\n' \
    >"${ISOLATED_ROOT}/deploy-progress/progress.sh"
output="$(
    run_isolated
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "empty derived name: exits 0"
assert_contains "${output}" "derived an empty artifact name" \
    "empty derived name: says the name was empty"
assert_equals "$(wc -l <"${GH_CALL_LOG}" | tr -d ' ')" "0" \
    "empty derived name: makes no API call"
pass "makes no API call when the derivation yields an empty name"

# The derivation itself fails.
printf '#!/bin/bash\nradius_deploy_artifact_name() { return 1; }\nradius_deploy_identity_segment() { :; }\n' \
    >"${ISOLATED_ROOT}/deploy-progress/progress.sh"
output="$(
    run_isolated
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "failing derivation: exits 0"
assert_contains "${output}" "could not derive the artifact name" \
    "failing derivation: says the name could not be derived"
assert_equals "$(wc -l <"${GH_CALL_LOG}" | tr -d ' ')" "0" \
    "failing derivation: makes no API call"
pass "makes no API call when the derivation fails"

# Injected control characters in the workflow inputs cannot forge a log line.
# The inputs only reach the log on these fail-closed paths; the derivation
# sanitizes them everywhere else.
printf '#!/bin/bash\nradius_deploy_artifact_name() { printf "%%s" ""; }\nradius_deploy_identity_segment() { :; }\n' \
    >"${ISOLATED_ROOT}/deploy-progress/progress.sh"
output="$(
    : >"${GH_CALL_LOG}"
    RUN_EXIT=0
    ENVIRONMENT="prod" \
        APPLICATION="$(printf 'billing\n::error::forged')" \
        GITHUB_REPOSITORY="octo/repo" \
        PATH="${STUB_BIN}:${PATH}" \
        bash "${ISOLATED_ROOT}/action/discard-deploy-status.sh" 2>&1 || RUN_EXIT=$?
    echo "__exit__${RUN_EXIT}"
)"
assert_contains "${output}" "__exit__0" "input log injection: exits 0"
assert_not_contains "${output}" "
::error::forged" "input log injection: does not start a forged log line"
assert_contains "${output}" "billing::error::forged" \
    "input log injection: keeps the text on the warning line"
pass "strips control characters from workflow inputs in warnings"

# An unhandled failure is reported rather than stepped over, and still does not
# fail the delete: `set -e` stops the script and the ERR trap exits 0.
cat >"${STUB_BIN}/mktemp" <<'STUB'
#!/bin/bash
exit 1
STUB
chmod +x "${STUB_BIN}/mktemp"
output="$(
    : >"${GH_CALL_LOG}"
    RUN_EXIT=0
    ENVIRONMENT="prod" APPLICATION="billing" \
        GITHUB_REPOSITORY="octo/repo" \
        PATH="${STUB_BIN}:${PATH}" \
        bash "${TARGET}" 2>&1 || RUN_EXIT=$?
    echo "__exit__${RUN_EXIT}"
)"
rm -f "${STUB_BIN}/mktemp"
assert_contains "${output}" "__exit__0" "unhandled failure: still exits 0"
assert_contains "${output}" "unexpected failure at line" \
    "unhandled failure: reports where it stopped"
assert_equals "$(wc -l <"${GH_CALL_LOG}" | tr -d ' ')" "0" \
    "unhandled failure: makes no API call"
pass "reports an unhandled failure without failing the delete"

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
