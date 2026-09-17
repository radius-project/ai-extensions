#!/usr/bin/env bash

lifecycle_validate_inputs() {
  local values=("${LIFECYCLE_VERSION:-}" "${LIFECYCLE_OPERATION:-}" "${OPERATION_ID:-}" "${ATTEMPT_ID:-}" "${EXPECTED_COMMIT:-}")
  local value count=0
  for value in "${values[@]}"; do
    if [[ -n "$value" ]]; then count=$((count + 1)); fi
  done
  [[ "$count" == 0 ]] && return 0
  [[ "$count" == 5 ]] || { echo "Incomplete lifecycle identity." >&2; return 2; }
  [[ "$LIFECYCLE_VERSION" == 1 && "$LIFECYCLE_OPERATION" == deployment.start ]] || return 2
  [[ "$OPERATION_ID" =~ ^[a-zA-Z0-9_-]{1,128}$ && "$ATTEMPT_ID" =~ ^[a-zA-Z0-9_-]{1,128}$ ]] || return 2
  [[ "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]] || return 2
  [[ "${GITHUB_REPOSITORY:-}" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || return 2
  [[ "${ENVIRONMENT:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || return 2
  [[ "${LIFECYCLE_APPLICATION:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || return 2
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ -z "${RAD_COMMANDS:-}" ]] || { echo "Lifecycle deployment does not accept arbitrary commands." >&2; return 2; }
}

lifecycle_initialize() {
  lifecycle_validate_inputs || return "$?"
  [[ -n "${LIFECYCLE_VERSION:-}" ]] || return 0
  local actual directory
  actual="$(git rev-parse HEAD)" || return "$?"
  [[ "$actual" == "$EXPECTED_COMMIT" ]] || { echo "Checked-out commit differs from approved source." >&2; return 3; }
  directory="${GITHUB_WORKSPACE}/.radius-lifecycle-${OPERATION_ID}-${ATTEMPT_ID}"
  # A checkout cannot supply prior evidence, including through a symlink.
  (umask 077; mkdir "$directory") || return 2
  export RADIUS_LIFECYCLE_FILE="$directory/lifecycle-result.json"
  jq -n \
    --arg operationId "$OPERATION_ID" --arg attemptId "$ATTEMPT_ID" \
    --arg operation "$LIFECYCLE_OPERATION" --arg repo "$GITHUB_REPOSITORY" \
    --arg environment "$ENVIRONMENT" --arg application "$LIFECYCLE_APPLICATION" \
    --arg expectedCommit "$EXPECTED_COMMIT" --arg actualCommit "$actual" \
    --argjson runId "$GITHUB_RUN_ID" --argjson runAttempt "$GITHUB_RUN_ATTEMPT" \
    --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{executionSchemaVersion:1,operationId:$operationId,attemptId:$attemptId,
      operation:$operation,repo:$repo,environment:$environment,application:$application,
      expectedCommit:$expectedCommit,actualCommit:$actualCommit,runId:$runId,
      runAttempt:$runAttempt,sequence:0,observedAt:$observedAt,
      phases:{restore:{outcome:"unknown",reason:"Not observed"},
        commands:{outcome:"unknown",reason:"Not observed"},
        stateSave:{outcome:"unknown",reason:"Not observed"},
        cleanup:{outcome:"unknown",reason:"Not observed"}},
      diagnostics:[],additionalFailures:[]}' > "$RADIUS_LIFECYCLE_FILE" || return "$?"
  printf 'RADIUS_LIFECYCLE_FILE=%s\n' "$RADIUS_LIFECYCLE_FILE" >> "$GITHUB_ENV"
}

lifecycle_record() {
  [[ -n "${RADIUS_LIFECYCLE_FILE:-}" ]] || return 0
  local phase="$1" outcome="$2" code="${3:-}" reason="${4:-Not observed}"
  case "$phase" in restore|commands|stateSave|cleanup) ;; *) return 2 ;; esac
  case "$outcome" in succeeded|failed|cancelled|skipped|unknown|not_applicable) ;; *) return 2 ;; esac
  # Only fixed helper-owned reasons are published. Command output remains
  # outside final authoritative evidence and cannot inject secrets into it.
  case "$reason" in
    "Not observed"|"Command exited"|"Restore did not succeed"|"Runner interrupted"|"Not required") ;;
    *) reason="Command exited" ;;
  esac
  [[ -z "$code" || "$code" =~ ^[0-9]+$ ]] || return 2
  jq --arg phase "$phase" --arg outcome "$outcome" --arg code "$code" \
    --arg reason "$reason" --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.sequence += 1 | .observedAt=$observedAt |
      .phases[$phase]={outcome:$outcome,reason:$reason} |
      if $code != "" then .phases[$phase].exitCode=($code|tonumber) else . end' \
    "$RADIUS_LIFECYCLE_FILE" > "${RADIUS_LIFECYCLE_FILE}.next" || return "$?"
  mv "${RADIUS_LIFECYCLE_FILE}.next" "$RADIUS_LIFECYCLE_FILE"
}

lifecycle_run() {
  local phase="$1" code=0
  shift
  if "$@"; then code=0; else code=$?; fi
  if [[ "$code" == 0 ]]; then
    lifecycle_record "$phase" succeeded "$code" "Command exited" || return "$?"
  else
    lifecycle_record "$phase" failed "$code" "Command exited" || true
  fi
  return "$code"
}

lifecycle_finalize() {
  [[ -n "${RADIUS_LIFECYCLE_FILE:-}" ]] || return 2
  jq '
    def failure($phase): {
      code:"PRECONDITION_FAILED",message:($phase+" failed."),
      retryable:false,nextAction:"Inspect this workflow; do not automatically repeat deployment."
    };
    [.phases | to_entries[] | select(.value.outcome=="failed") | .key] as $failed |
    (["restore","commands","stateSave","cleanup"] | map(select(. as $p | $failed | index($p)))) as $ordered |
    if ($ordered|length)>0 then
      .primaryFailure=failure($ordered[0]) |
      .additionalFailures=($ordered[1:]|map(failure(.)))
    else . end
  ' "$RADIUS_LIFECYCLE_FILE" > "${RADIUS_LIFECYCLE_FILE}.next" || return "$?"
  mv "${RADIUS_LIFECYCLE_FILE}.next" "$RADIUS_LIFECYCLE_FILE"
}
