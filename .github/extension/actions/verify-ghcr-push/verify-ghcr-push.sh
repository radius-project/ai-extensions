#!/bin/bash
# Checks that the workflow token can push to the Radius state package in GHCR.
# rad shutdown pushes the state in Teardown, after the run changed resources,
# so a missing package permission should fail here first, before any change.
#
# The probe starts a blob upload and never completes it, so it creates no
# package version. GHCR rejects cancelling the session and expires it.
#
# Inputs (environment):
#   STATE_REGISTRY              vars.RADIUS_STATE_REGISTRY; skipped when empty or not on ghcr.io
#   GH_ACTOR, GH_TOKEN          the workflow actor and a token with packages: write
# Writes GHCR_PUSH_CHECK=ok, failed, or skipped to GITHUB_ENV.
#
# Canvas classifies a failure in this step as a permissions problem when the
# log has 401, 403, or Forbidden. Only a real denial may say those words.
set -uo pipefail

# shellcheck source=.github/extension/scripts/workflow-annotations.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/workflow-annotations.sh"

record() { echo "GHCR_PUSH_CHECK=$1" >>"$GITHUB_ENV"; }

registry="${STATE_REGISTRY:-}"
if [[ -z "$registry" ]]; then
  echo "RADIUS_STATE_REGISTRY is not set for this environment; skipping GHCR package push check."
  record skipped
  exit 0
fi
if [[ "$registry" != ghcr.io/* ]]; then
  echo "RADIUS_STATE_REGISTRY ($registry) is not on ghcr.io; skipping GHCR package push check."
  record skipped
  exit 0
fi

repo_path="${registry#ghcr.io/}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
STATUS_FIX="Rerun the workflow. If it fails again, check https://www.githubstatus.com for a Packages incident."
ACCESS_FIX="In the package's settings on GitHub, under Manage Actions access, give this repository the Write role, or connect the package to this repository. Then rerun the workflow."

# http <curl args>: prints the HTTP status. curl's own error goes to $work/err.
http() {
  curl -sS --connect-timeout 5 --max-time 20 -o "$work/body" -w '%{http_code}' "$@" 2>"$work/err"
}

err_text() {
  head -c 300 "$work/err" | tr '\r\n' '  ' | sed 's/^ *//; s/ *$//'
}

denied() {
  local reason=Forbidden
  [[ "$1" != 401 ]] || reason=Unauthorized
  record failed
  annotate error GHCR_PUSH_DENIED "Workflow token cannot push to the state package" \
    "GHCR answered HTTP $1 ($reason) when the workflow token asked to push to the Radius state package $registry. GHCR does not give a repository's workflows write access to a package by default." \
    "$ACCESS_FIX"
  exit 1
}

echo "Checking push permission for $registry as ${GH_ACTOR:-}..."

if ! status=$(http -u "${GH_ACTOR:-}:${GH_TOKEN:-}" "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo_path}:pull,push"); then
  annotate error GHCR_UNREACHABLE "GHCR unreachable" \
    "Could not connect to the GHCR token endpoint for $registry: $(err_text)." "$STATUS_FIX"
  exit 1
fi
case "$status" in
  200) ;;
  401 | 403) denied "$status" ;;
  *)
    annotate error GHCR_UNREACHABLE "GHCR unreachable" \
      "The GHCR token endpoint returned HTTP $status for $registry." "$STATUS_FIX"
    exit 1
    ;;
esac

token=$(jq -r '.token // .access_token // empty' "$work/body" 2>/dev/null) || token=""
if [[ -z "$token" ]]; then
  annotate error GHCR_UNREACHABLE "GHCR unreachable" \
    "The GHCR token endpoint returned no token for $registry." "$STATUS_FIX"
  exit 1
fi

# GHCR tokens are not guaranteed to be JWTs, so test push access directly.
if ! status=$(http -X POST -H "Content-Length: 0" -H "Authorization: Bearer $token" \
  "https://ghcr.io/v2/${repo_path}/blobs/uploads/"); then
  annotate error GHCR_PROBE_FAILED "GHCR push check failed" \
    "Could not start the push check against $registry: $(err_text)." "$STATUS_FIX"
  exit 1
fi
case "$status" in
  202)
    echo "✅ Workflow token has push permission to $registry"
    record ok
    ;;
  401 | 403) denied "$status" ;;
  *)
    annotate error GHCR_PROBE_FAILED "GHCR push check failed" \
      "The push check against $registry got HTTP $status, which does not show whether the workflow token can push." "$STATUS_FIX"
    exit 1
    ;;
esac
