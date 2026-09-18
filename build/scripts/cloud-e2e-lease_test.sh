#!/bin/bash

# ============================================================================
# Behavior tests for the cloud-e2e-cleanup lease step.
#
# The step script is extracted from `.github/workflows/cloud-e2e-cleanup.yml`
# and executed for real against stubs for `gh`, `node` and `sleep` on PATH:
# there is no runner, no network and no GitHub API. Structural assertions over
# the workflow text cannot tell a working retry loop from a broken one, so the
# lease paths that wedge the shared mutex when they regress are exercised here
# instead.
#
# The mutex these paths protect is held across the whole Cloud E2E suite. A
# lease that outlives its run fails every subsequent run until a human deletes
# the ref, so each acquisition path, the ownership guard and the failure trap
# are all covered.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly WORKFLOW="${REPO_ROOT}/.github/workflows/cloud-e2e-cleanup.yml"
readonly STEP_NAME="Reset the fixture default branch under the shared lease"

TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

readonly STUB_BIN="${TEST_ROOT}/bin"
readonly TARGET="${TEST_ROOT}/lease-step.sh"
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
# Extract the step's `run:` block. Keyed on the step name so a rename breaks
# the extraction loudly rather than silently testing nothing.
# ---------------------------------------------------------------------------
extract_step_script() {
    awk -v name="      - name: ${STEP_NAME}" '
        $0 == name { found = 1 }
        found && $0 == "        run: |" { capture = 1; next }
        capture {
            if ($0 != "" && $0 !~ /^          /) exit
            sub(/^          /, "")
            print
        }
    ' "${WORKFLOW}"
}

extract_step_script >"${TARGET}"
[[ -s "${TARGET}" ]] ||
    fail "could not extract the '${STEP_NAME}' step from ${WORKFLOW}"
grep -q "release_orphaned_lease" "${TARGET}" ||
    fail "extracted script does not look like the lease step"

readonly REPOSITORY="fixture-owner/fixture-repo"
readonly LEASE_REF="refs/heads/radius/cloud-e2e-lease"
readonly LEASE_READ_MATCH="git/ref/heads/radius/cloud-e2e-lease"
readonly LEASE_WRITE_MATCH="git/refs/heads/radius/cloud-e2e-lease"
readonly BASELINE="cc6a688acc6a688acc6a688acc6a688acc6a688a"
readonly OUR_LEASE_SHA="aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111"
readonly OTHER_LEASE_SHA="bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222"

# ---------------------------------------------------------------------------
# Stubs. `gh` answers from per-scenario environment variables and records every
# call; reads of the lease ref are answered from a scripted sequence so a test
# can reproduce a stale replica that 404s before catching up.
# ---------------------------------------------------------------------------
cat >"${STUB_BIN}/gh" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >>"${GH_CALL_LOG}"
args="$*"

case "${args}" in
*"-X DELETE"*"${LEASE_WRITE_MATCH}"*)
    exit "${STUB_DELETE_LEASE_EXIT:-0}"
    ;;
*"-X PATCH"*"git/refs/heads/main"*)
    exit "${STUB_PATCH_BRANCH_EXIT:-0}"
    ;;
*"--method POST"*"git/refs"*)
    exit "${STUB_CREATE_REF_EXIT:-0}"
    ;;
*"--method POST"*"git/commits"*)
    printf '%s\n' "${STUB_LEASE_COMMIT_SHA}"
    exit 0
    ;;
*"git/commits/"*"--jq .message"*)
    if [[ -n "${STUB_OWNER_MARKER_FAILS:-}" ]]; then
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
    fi
    printf '%s\n' "${STUB_LEASE_MESSAGE:-cloud-e2e lease}"
    exit 0
    ;;
*"git/commits/"*"--jq .tree.sha"*)
    printf '%s\n' "treeshatreeshatreeshatreeshatreeshatree0"
    exit 0
    ;;
*"run view"*)
    if [[ -n "${STUB_OWNER_STATUS_FAILS:-}" ]]; then
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
    fi
    printf '%s\n' "${STUB_OWNER_STATUS:-completed}"
    exit 0
    ;;
*"${LEASE_READ_MATCH}"*)
    n="$(cat "${LEASE_READ_COUNT}" 2>/dev/null || echo 0)"
    n=$((n + 1))
    printf '%s' "${n}" >"${LEASE_READ_COUNT}"
    line="$(sed -n "${n}p" "${LEASE_READ_SEQ}")"
    if [[ -z "${line}" || "${line}" == "404" ]]; then
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
    fi
    printf '%s\n' "${line}"
    exit 0
    ;;
*"git/ref/heads/main"*)
    printf '%s\n' "${STUB_BRANCH_SHA}"
    exit 0
    ;;
esac

echo "unstubbed gh call: ${args}" >&2
exit 90
STUB
chmod +x "${STUB_BIN}/gh"

# The step shells out to node only to read or build the lease commit message.
cat >"${STUB_BIN}/node" <<'STUB'
#!/bin/bash
if [[ -n "${LEASE_MESSAGE:-}" ]]; then
    printf '%s' "${STUB_OWNER_RUN_ID-4242}"
    exit 0
fi
printf '%s' "cloud-e2e lease for run ${GITHUB_RUN_ID}"
STUB
chmod +x "${STUB_BIN}/node"

# Real sleeps would make the retry tests take 15 seconds each.
cat >"${STUB_BIN}/sleep" <<'STUB'
#!/bin/bash
printf 'sleep %s\n' "$*" >>"${SLEEP_CALL_LOG}"
STUB
chmod +x "${STUB_BIN}/sleep"

# ---------------------------------------------------------------------------
# Run the extracted step with a clean call log. `lease_reads` scripts what each
# successive read of the lease ref returns; "404" reproduces a stale replica.
# Echoes combined output plus a trailing exit marker.
# ---------------------------------------------------------------------------
run_step() {
    local lease_reads="$1"
    shift

    GH_CALL_LOG="${TEST_ROOT}/gh-calls.log"
    SLEEP_CALL_LOG="${TEST_ROOT}/sleep-calls.log"
    LEASE_READ_SEQ="${TEST_ROOT}/lease-reads.txt"
    LEASE_READ_COUNT="${TEST_ROOT}/lease-reads.count"
    : >"${GH_CALL_LOG}"
    : >"${SLEEP_CALL_LOG}"
    printf '%s\n' "${lease_reads}" >"${LEASE_READ_SEQ}"
    rm -f "${LEASE_READ_COUNT}"

    local summary="${TEST_ROOT}/step-summary.md"
    : >"${summary}"
    local runner_temp="${TEST_ROOT}/runner-temp"
    mkdir -p "${runner_temp}"

    local exit_code=0
    env -i \
        PATH="${STUB_BIN}:/usr/bin:/bin" \
        HOME="${HOME}" \
        GH_CALL_LOG="${GH_CALL_LOG}" \
        SLEEP_CALL_LOG="${SLEEP_CALL_LOG}" \
        LEASE_READ_SEQ="${LEASE_READ_SEQ}" \
        LEASE_READ_COUNT="${LEASE_READ_COUNT}" \
        LEASE_READ_MATCH="${LEASE_READ_MATCH}" \
        LEASE_WRITE_MATCH="${LEASE_WRITE_MATCH}" \
        RUNNER_TEMP="${runner_temp}" \
        GITHUB_STEP_SUMMARY="${summary}" \
        GITHUB_REPOSITORY="radius-project/ai-extensions" \
        GITHUB_RUN_ID="99999" \
        GH_TOKEN="stub-token" \
        SOURCE_GH_TOKEN="stub-source-token" \
        FIXTURE_REPOSITORY="${REPOSITORY}" \
        DEFAULT_BRANCH="main" \
        BASELINE_SHA="${BASELINE}" \
        LEASE_REF="${LEASE_REF}" \
        STUB_LEASE_COMMIT_SHA="${OUR_LEASE_SHA}" \
        STUB_BRANCH_SHA="${BASELINE}" \
        "$@" \
        bash "${TARGET}" 2>&1 || exit_code=$?
    echo "__exit__${exit_code}"
}

gh_calls() {
    cat "${TEST_ROOT}/gh-calls.log"
}

lease_deletes() {
    grep -c -- "-X DELETE" "${TEST_ROOT}/gh-calls.log" || true
}

# ---------------------------------------------------------------------------
# A read issued immediately after creating the ref can 404 on a stale replica.
# Without the retry the step dies under `set -e` holding the mutex.
# ---------------------------------------------------------------------------
output="$(run_step "404
404
404
${OUR_LEASE_SHA}
${OUR_LEASE_SHA}")"
assert_contains "${output}" "__exit__0" "read-after-write lag: step succeeds"
assert_contains "${output}" "Acquired ${LEASE_REF}" "read-after-write lag: acquires"
assert_not_contains "${output}" "Could not re-read" "read-after-write lag: no abort"
assert_equals "$(lease_deletes)" "1" "read-after-write lag: releases exactly once"
[[ -s "${TEST_ROOT}/sleep-calls.log" ]] ||
    fail "read-after-write lag: expected the retry to back off between attempts"
pass "retries a lagging read instead of dying while holding the lease"

# ---------------------------------------------------------------------------
# The retry is bounded. Five failed attempts must abort rather than loop, and
# the trap must still deal with the lease.
# ---------------------------------------------------------------------------
output="$(run_step "404
404
404
404
404
404
404
404")"
assert_contains "${output}" "__exit__1" "exhausted retry: step fails"
assert_contains "${output}" "Could not re-read ${LEASE_REF} to confirm ownership" \
    "exhausted retry: reports the failed verification"
assert_contains "${output}" "the lease may still be held" \
    "exhausted retry: trap reports the lease state as unknown"
assert_not_contains "${output}" "appears to be gone" \
    "exhausted retry: never claims an unreadable lease is gone"
assert_equals "$(lease_deletes)" "0" \
    "exhausted retry: never deletes a lease it could not read"
assert_equals "$(grep -c "sleep" "${TEST_ROOT}/sleep-calls.log")" "10" \
    "exhausted retry: backs off five times in the step and five more in the trap"
pass "gives up after five attempts instead of looping forever"

# ---------------------------------------------------------------------------
# The trap runs on the same lagging replica that aborted the step, so its own
# read must retry. A single read here would report the lease gone and leave the
# mutex held by this dead run: the exact wedge this change exists to prevent.
# ---------------------------------------------------------------------------
output="$(run_step "404
${OUR_LEASE_SHA}
404
404
404
${OUR_LEASE_SHA}" STUB_PATCH_BRANCH_EXIT=1 STUB_BRANCH_SHA="dddd4444dddd4444dddd4444dddd4444dddd4444")"
assert_contains "${output}" "Released ${LEASE_REF} after cleanup failed while holding it." \
    "lagging trap: releases the lease once the replica catches up"
assert_not_contains "${output}" "appears to be gone" \
    "lagging trap: never mistakes replica lag for a deleted lease"
assert_equals "$(lease_deletes)" "1" "lagging trap: deletes the lease once"
pass "retries a lagging read in the failure trap instead of abandoning the lease"

# ---------------------------------------------------------------------------
# The ownership guard. A lease that changed hands must never be deleted.
# ---------------------------------------------------------------------------
output="$(run_step "404
${OTHER_LEASE_SHA}
${OTHER_LEASE_SHA}")"
assert_contains "${output}" "__exit__1" "stolen lease: step fails"
assert_contains "${output}" "changed while cleanup was establishing ownership" \
    "stolen lease: reports the change"
assert_contains "${output}" "now points at another owner" \
    "stolen lease: trap reports it left the lease alone"
assert_equals "$(lease_deletes)" "0" "stolen lease: never deletes another owner"
pass "refuses to delete a lease that changed hands"

# ---------------------------------------------------------------------------
# The regression this change exists for: failing while holding the lease must
# release it, or every later Cloud E2E run fails until a human deletes the ref.
# ---------------------------------------------------------------------------
output="$(run_step "404
${OUR_LEASE_SHA}
${OUR_LEASE_SHA}" STUB_PATCH_BRANCH_EXIT=1 STUB_BRANCH_SHA="dddd4444dddd4444dddd4444dddd4444dddd4444")"
assert_contains "${output}" "Released ${LEASE_REF} after cleanup failed while holding it." \
    "failure trap: releases the lease"
assert_equals "$(lease_deletes)" "1" "failure trap: deletes the lease once"
pass "releases the lease when the run fails holding it"

# ---------------------------------------------------------------------------
# A trap that cannot release the lease must say so: silence here reads as a
# successful release and sends operators looking in the wrong place.
# ---------------------------------------------------------------------------
output="$(run_step "404
${OUR_LEASE_SHA}
${OUR_LEASE_SHA}" STUB_PATCH_BRANCH_EXIT=1 STUB_DELETE_LEASE_EXIT=1 \
    STUB_BRANCH_SHA="dddd4444dddd4444dddd4444dddd4444dddd4444")"
assert_contains "${output}" "Could not release ${LEASE_REF}" \
    "unreleasable lease: reports the failure"
assert_contains "${output}" "Cloud E2E stays blocked" \
    "unreleasable lease: names the consequence"
pass "reports a lease it failed to release"

# ---------------------------------------------------------------------------
# A create that reports failure may still have landed. Treating the resulting
# ref as someone else's leaves this run's own write abandoned and wedges the
# mutex, which is the exact failure the trap exists to prevent.
# ---------------------------------------------------------------------------
output="$(run_step "404
${OUR_LEASE_SHA}
${OUR_LEASE_SHA}
${OUR_LEASE_SHA}" STUB_CREATE_REF_EXIT=1)"
assert_contains "${output}" "__exit__0" "ambiguous create: step succeeds"
assert_contains "${output}" "created despite a failed create response" \
    "ambiguous create: reports that it owns the ref"
assert_equals "$(lease_deletes)" "1" "ambiguous create: releases the lease it created"
pass "claims a lease whose create reported failure after landing"

# ---------------------------------------------------------------------------
# The same failed create with someone else's ref is a genuine concurrent owner
# and must be left strictly alone.
# ---------------------------------------------------------------------------
output="$(run_step "404
${OTHER_LEASE_SHA}" STUB_CREATE_REF_EXIT=1)"
assert_contains "${output}" "__exit__0" "concurrent owner: step exits cleanly"
assert_contains "${output}" "was acquired concurrently" \
    "concurrent owner: reports the concurrent acquisition"
assert_equals "$(lease_deletes)" "0" "concurrent owner: touches nothing"
pass "leaves a genuinely concurrent owner alone"

# ---------------------------------------------------------------------------
# Reclaiming an abandoned lease must also mark ownership, or the trap skips the
# release and the mutex stays wedged after a failure.
# ---------------------------------------------------------------------------
output="$(run_step "${OTHER_LEASE_SHA}
${OTHER_LEASE_SHA}
${OTHER_LEASE_SHA}" STUB_LEASE_COMMIT_SHA="${OTHER_LEASE_SHA}" \
    STUB_OWNER_STATUS=completed STUB_PATCH_BRANCH_EXIT=1 \
    STUB_BRANCH_SHA="dddd4444dddd4444dddd4444dddd4444dddd4444")"
assert_contains "${output}" "Reclaiming ${LEASE_REF} from completed owner run" \
    "reclaimed lease: reclaims from the completed owner"
assert_contains "${output}" "Released ${LEASE_REF} after cleanup failed while holding it." \
    "reclaimed lease: the trap releases a reclaimed lease too"
pass "releases a reclaimed lease when the run then fails"

# ---------------------------------------------------------------------------
# A lease whose owner is still running is not ours to touch.
# ---------------------------------------------------------------------------
output="$(run_step "${OTHER_LEASE_SHA}" STUB_OWNER_STATUS=in_progress)"
assert_contains "${output}" "__exit__0" "live owner: exits cleanly"
assert_contains "${output}" "is in_progress" "live owner: reports why it stopped"
assert_equals "$(lease_deletes)" "0" "live owner: touches nothing"
pass "leaves a lease held by a running owner intact"

# ---------------------------------------------------------------------------
# A lease with no verifiable Actions owner is a local run's; cleanup must not
# reclaim it, because nothing proves that run has finished.
# ---------------------------------------------------------------------------
output="$(run_step "${OTHER_LEASE_SHA}" STUB_OWNER_RUN_ID=)"
assert_contains "${output}" "__exit__0" "local lease: exits cleanly"
assert_contains "${output}" "no verifiable GitHub Actions owner" \
    "local lease: reports why it stopped"
assert_equals "$(lease_deletes)" "0" "local lease: touches nothing"
pass "leaves a lease with no verifiable Actions owner intact"

# ---------------------------------------------------------------------------
# The success path must release the lease exactly once, after the reset.
# ---------------------------------------------------------------------------
output="$(run_step "404
${OUR_LEASE_SHA}
${OUR_LEASE_SHA}" STUB_BRANCH_SHA="dddd4444dddd4444dddd4444dddd4444dddd4444")"
assert_contains "${output}" "__exit__0" "success path: step succeeds"
assert_equals "$(lease_deletes)" "1" "success path: releases exactly once"
calls="$(gh_calls)"
patch_line="$(grep -n -- "-X PATCH" <<<"${calls}" | head -n 1 | cut -d: -f1)"
delete_line="$(grep -n -- "-X DELETE" <<<"${calls}" | head -n 1 | cut -d: -f1)"
[[ "${patch_line}" -lt "${delete_line}" ]] ||
    fail "success path: the branch reset must happen before the lease is released"
assert_not_contains "${output}" "after cleanup failed" \
    "success path: the failure trap stays quiet"
pass "resets the branch before releasing the lease"

echo "All cloud-e2e lease step tests passed."
