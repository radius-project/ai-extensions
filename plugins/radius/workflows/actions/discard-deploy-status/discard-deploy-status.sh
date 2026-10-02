#!/bin/bash

# Removes the deploy-status workflow artifacts that describe one deleted
# application, so the canvas "Deployed" graph stops rendering a deployment that
# no longer exists.
#
# The Deployed view is painted from the newest
# `radius-deploy-status-<environment>-<application>` artifact, which outlives
# the deployment it describes: `rad app delete` removes the Radius resources
# and the GitHub deployment record, but the artifact survives on its own
# retention schedule. GitHub does not expose a workflow_dispatch run's inputs,
# so nothing reading the deployment history afterwards can tell which
# application was deleted -- this delete run, which was handed both the
# environment and the application name, is the only actor that can name the
# artifact for exactly that pair.
#
# Scope is exact by identity, not by name. The artifact name is a sanitized,
# truncated derivation of the pair, so distinct pairs can collide on one name --
# `(prod, billing/east)`, `(prod-billing, east)` and `(Prod, Billing-East)` all
# derive `radius-deploy-status-prod-billing-east`. The name is therefore only
# used as a cheap server-side filter; before anything is deleted, each candidate
# is downloaded and the `application=` and `environment=` its `deploy-state.txt`
# records must denote the pair being deleted.
#
# Those two segments are compared through the shared sanitizer, which is exactly
# how the canvas reader's confirmArtifactIdentity decides an artifact belongs to
# a deployment. Matching the reader is the point of the whole action: anything
# it would still render for this pair has to go, or the Deployed graph stays
# stale -- so `(Prod, Billing-East)` is this deployment even though the recorded
# text differs. Comparing each segment on its own is what stops that from
# over-reaching: `(prod-billing, east)` collides on the name but on neither
# segment, so it survives untouched.
#
# Live progress slots (`<name>-live-<run-id>-slot-<n>`) are deliberately not
# removed: a repo-wide read excludes them because their sequences are only
# comparable within one run, so they cannot resurrect the deleted graph, and
# they carry a one-day retention.
#
# Best-effort by design. The application is already deleted by the time this
# runs, so a listing or delete failure warns and exits 0 rather than failing an
# otherwise successful delete; the stale artifact then expires on its own.
# Best-effort never means best-guess, though: every path that cannot establish
# the exact artifact name -- a missing helper, an underivable or empty name --
# exits before contacting the API, because an unscoped request here would delete
# artifacts belonging to other applications. For the same reason a candidate
# whose identity cannot be confirmed is skipped rather than deleted: leaving a
# stale artifact to expire is recoverable, deleting another application's
# deployed graph is not.

set -euo pipefail

# Strip control characters from everything printed, because warnings carry text
# from outside this script: workflow inputs (the environment and application
# names) and GitHub API error bodies. A newline in any of those would otherwise
# start a new log line and let the caller inject a workflow command such as
# `::error::` or `::add-mask::`. Sanitizing inside `warn` rather than at each
# call site means no future warning can forget to do it.
warn() {
    printf '::warning::Deployed graph cleanup: %s\n' \
        "$(printf '%s' "$*" | LC_ALL=C tr -d '[:cntrl:]')"
}

# `-e` stops at the first unhandled failure so an accidental regression cannot be
# silently stepped over, but this action must still never fail an otherwise
# successful delete (see the header). This trap reconciles the two: an unexpected
# failure is reported and ends the cleanup, and the step still succeeds.
report_unexpected_failure() {
    local status="$1" line="$2"
    warn "unexpected failure at line ${line} (exit ${status}); no further artifacts were removed."
    exit 0
}

trap 'report_unexpected_failure "$?" "${LINENO}"' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

readonly ENVIRONMENT="${ENVIRONMENT:-}"
readonly APPLICATION="${APPLICATION:-}"
readonly REPOSITORY="${GITHUB_REPOSITORY:-}"

# Every artifact carries this file, in which the producer recorded the raw
# environment and application it was given. It is the only trustworthy statement
# of which deployment an artifact describes.
readonly STATE_FILE="deploy-state.txt"

if [[ -z "${ENVIRONMENT//[[:space:]]/}" || -z "${APPLICATION//[[:space:]]/}" ]]; then
    warn "no environment or application name supplied; nothing to remove."
    exit 0
fi

if [[ -z "${REPOSITORY//[[:space:]]/}" ]]; then
    warn "GITHUB_REPOSITORY is not set; nothing to remove."
    exit 0
fi

# Load the shared derivation only after the identity checks, so a missing
# helper is reported against a request that would otherwise have deleted
# something. Every failure below exits before any API call: an empty `name=`
# filter is treated by the REST API as "no filter" and lists the repository's
# entire artifact history, so a script that carried on with an unset name would
# delete every artifact in the repository rather than this application's.
readonly HELPER="${SCRIPT_DIR}/../deploy-progress/progress.sh"

if [[ ! -r "${HELPER}" ]]; then
    warn "cannot read ${HELPER}; nothing to remove."
    exit 0
fi

# `source` is a special builtin, so under `set -e` bash exits the moment it
# fails -- even from an `if !` guard, which suppresses `-e` for ordinary
# commands. Disabling `-e` across just this call is what keeps a broken helper
# on the fail-closed path instead of aborting the step.
set +e
# Resolved at run time from the action directory, so shellcheck cannot follow it.
# shellcheck source=/dev/null disable=SC1091
source "${HELPER}"
helper_status=$?
set -e
if [[ "${helper_status}" -ne 0 ]]; then
    warn "could not load ${HELPER} (exit ${helper_status}); nothing to remove."
    exit 0
fi

for helper_function in radius_deploy_artifact_name radius_deploy_identity_segment; do
    if ! declare -F "${helper_function}" >/dev/null; then
        warn "the shared ${helper_function} helper is unavailable; nothing to remove."
        exit 0
    fi
done

# Already sanitized to [a-z0-9._-] by the shared derivation, so it is safe to
# interpolate into both a log line and a REST query.
if ! ARTIFACT_NAME="$(radius_deploy_artifact_name "${ENVIRONMENT}" "${APPLICATION}")"; then
    warn "could not derive the artifact name for '${ENVIRONMENT}/${APPLICATION}'; nothing to remove."
    exit 0
fi
readonly ARTIFACT_NAME

if [[ -z "${ARTIFACT_NAME//[[:space:]]/}" ]]; then
    warn "derived an empty artifact name for '${ENVIRONMENT}/${APPLICATION}'; nothing to remove."
    exit 0
fi

ERROR_FILE="$(mktemp)"
readonly ERROR_FILE
WORK_DIR="$(mktemp -d)"
readonly WORK_DIR
trap 'rm -rf "${ERROR_FILE}" "${WORK_DIR}"' EXIT

# Reads one `key=value` line from a downloaded `deploy-state.txt`. The producer
# writes the value raw and unquoted as the rest of the line, so everything after
# the first `=` is the value; only the first occurrence is honoured so a value
# containing a newline cannot introduce a second, forged field.
state_field() {
    local key="$1" state="$2"
    printf '%s' "${state}" | sed -n "s/^${key}=//p" | head -n 1
}

# Confirms that an artifact really describes the pair being deleted, by reading
# the identity the producer recorded inside it rather than trusting the name it
# was filtered by. Returns non-zero for a mismatch and for every case where the
# identity cannot be established, so an unreadable artifact is kept rather than
# deleted on the strength of a name that other pairs can also derive.
artifact_describes_target() {
    local artifact_id="$1"
    local zip_file="${WORK_DIR}/${artifact_id}.zip" state=""

    if ! gh api "repos/${REPOSITORY}/actions/artifacts/${artifact_id}/zip" \
        >"${zip_file}" 2>"${ERROR_FILE}"; then
        warn "could not download artifact ${artifact_id} to confirm what it describes, so it was left in place: $(cat "${ERROR_FILE}")"
        return 1
    fi

    if ! state="$(unzip -p "${zip_file}" "${STATE_FILE}" 2>"${ERROR_FILE}")"; then
        warn "artifact ${artifact_id} has no readable ${STATE_FILE}, so what it describes could not be confirmed and it was left in place."
        return 1
    fi

    local recorded_application recorded_environment
    recorded_application="$(state_field application "${state}")"
    recorded_environment="$(state_field environment "${state}")"

    if [[ -z "${recorded_application}" || -z "${recorded_environment}" ]]; then
        warn "artifact ${artifact_id} does not record which application and environment it describes, so it was left in place."
        return 1
    fi

    # Compared per segment through the shared sanitizer, which is what the
    # canvas reader's confirmArtifactIdentity does. Matching the reader's notion
    # of identity is the whole point: anything it would still render for this
    # pair has to go, so an artifact recorded as "Prod"/"Billing-East" is the
    # deleted deployment even though the raw text differs. Sanitizing each
    # segment separately is what keeps that from over-reaching -- the pair
    # (prod-billing, east) collides on the artifact *name* but not on either
    # segment, so it survives.
    local want_application want_environment
    want_application="$(radius_deploy_identity_segment "${APPLICATION}")"
    want_environment="$(radius_deploy_identity_segment "${ENVIRONMENT}")"

    [[ "$(radius_deploy_identity_segment "${recorded_application}")" == "${want_application}" ]] || return 1
    [[ "$(radius_deploy_identity_segment "${recorded_environment}")" == "${want_environment}" ]]
}

# `name=` is an exact-match filter, so paging is bounded by how many runs
# published under this one name rather than by the repository's entire artifact
# history. Expired artifacts are already unreadable, so they are skipped.
if ! ARTIFACT_IDS="$(gh api --paginate --method GET \
    "repos/${REPOSITORY}/actions/artifacts" \
    -f "name=${ARTIFACT_NAME}" \
    -F per_page=100 \
    --jq '.artifacts[] | select(.expired == false) | .id' \
    2>"${ERROR_FILE}")"; then
    warn "could not list '${ARTIFACT_NAME}' artifacts: $(cat "${ERROR_FILE}")"
    exit 0
fi

deleted=0
failed=0
skipped=0
while IFS= read -r artifact_id; do
    # Defensive: only ever interpolate a bare artifact id into the request path,
    # whatever the listing returned.
    [[ "${artifact_id}" =~ ^[0-9]+$ ]] || continue
    if ! artifact_describes_target "${artifact_id}"; then
        skipped=$((skipped + 1))
        continue
    fi
    if gh api --method DELETE \
        "repos/${REPOSITORY}/actions/artifacts/${artifact_id}" \
        --silent 2>"${ERROR_FILE}"; then
        deleted=$((deleted + 1))
    else
        failed=$((failed + 1))
        warn "could not delete artifact ${artifact_id}: $(cat "${ERROR_FILE}")"
    fi
done <<<"${ARTIFACT_IDS}"

if [[ "${failed}" -gt 0 ]]; then
    warn "removed ${deleted} of $((deleted + failed)) '${ARTIFACT_NAME}' artifacts belonging to this application; the Deployed graph may keep showing it until the rest expire."
    exit 0
fi

if [[ "${deleted}" -eq 0 ]]; then
    if [[ "${skipped}" -gt 0 ]]; then
        warn "none of the ${skipped} '${ARTIFACT_NAME}' artifact(s) could be confirmed as belonging to this application, so none were removed."
        exit 0
    fi
    echo "No '${ARTIFACT_NAME}' artifacts to remove."
    exit 0
fi

echo "✅ Removed ${deleted} '${ARTIFACT_NAME}' artifact(s); the Deployed graph no longer has a deployment to show for this application."
