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

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# Resolved at run time from the action directory, so shellcheck cannot follow it.
# shellcheck source=/dev/null disable=SC1091
source "${SCRIPT_DIR}/../deploy-progress/progress.sh"

readonly ENVIRONMENT="${ENVIRONMENT:-}"
readonly APPLICATION="${APPLICATION:-}"
readonly REPOSITORY="${GITHUB_REPOSITORY:-}"

warn() {
    echo "::warning::Deployed graph cleanup: $*"
}

# Strip control characters from anything that came from outside this script: a
# newline in an error body could otherwise start a new log line and inject a
# GitHub Actions workflow command.
sanitize_for_log() {
    tr -d '[:cntrl:]'
}

if [[ -z "${ENVIRONMENT//[[:space:]]/}" || -z "${APPLICATION//[[:space:]]/}" ]]; then
    warn "no environment or application name supplied; nothing to remove."
    exit 0
fi

if [[ -z "${REPOSITORY//[[:space:]]/}" ]]; then
    warn "GITHUB_REPOSITORY is not set; nothing to remove."
    exit 0
fi

# Already sanitized to [a-z0-9._-] by the shared derivation, so it is safe to
# interpolate into both a log line and a REST query.
ARTIFACT_NAME="$(radius_deploy_artifact_name "${ENVIRONMENT}" "${APPLICATION}")"
readonly ARTIFACT_NAME

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
    warn "could not list '${ARTIFACT_NAME}' artifacts: $(sanitize_for_log <"${ERROR_FILE}")"
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
        warn "could not delete artifact ${artifact_id}: $(sanitize_for_log <"${ERROR_FILE}")"
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
