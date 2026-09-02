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
# Scope is exact by construction: only artifacts whose name equals the one this
# (environment, application) pair produces are removed, using the same
# derivation the producer and the canvas reader use. Another application in the
# same environment, or the same application in another environment, produces a
# different name and is left untouched. Live progress slots
# (`<name>-live-<run-id>-slot-<n>`) are deliberately not removed: a repo-wide
# read excludes them because their sequences are only comparable within one run,
# so they cannot resurrect the deleted graph, and they carry a one-day retention.
#
# Best-effort by design. The application is already deleted by the time this
# runs, so a listing or delete failure warns and exits 0 rather than failing an
# otherwise successful delete; the stale artifact then expires on its own.
# Best-effort never means best-guess, though: every path that cannot establish
# the exact artifact name -- a missing helper, an underivable or empty name --
# exits before contacting the API, because an unscoped request here would delete
# artifacts belonging to other applications.

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

if ! declare -F radius_deploy_artifact_name >/dev/null; then
    warn "the shared radius_deploy_artifact_name helper is unavailable; nothing to remove."
    exit 0
fi

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
trap 'rm -f "${ERROR_FILE}"' EXIT

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
while IFS= read -r artifact_id; do
    # Defensive: only ever interpolate a bare artifact id into the request path,
    # whatever the listing returned.
    [[ "${artifact_id}" =~ ^[0-9]+$ ]] || continue
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
    warn "removed ${deleted} of $((deleted + failed)) '${ARTIFACT_NAME}' artifacts; the Deployed graph may keep showing this application until the rest expire."
    exit 0
fi

if [[ "${deleted}" -eq 0 ]]; then
    echo "No '${ARTIFACT_NAME}' artifacts to remove."
    exit 0
fi

echo "✅ Removed ${deleted} '${ARTIFACT_NAME}' artifact(s); the Deployed graph no longer has a deployment to show for this application."
