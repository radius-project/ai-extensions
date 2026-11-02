#!/bin/bash

# Retry only a terminal recipe failure, never an unknown deployment outcome.
radius_deploy_with_reconnect() (
    set -o pipefail
    local output code attempt
    local -a statuses
    output="$(mktemp)" || return 1
    trap 'rm -f "$output"' EXIT

    for attempt in 1 2 3; do
        if rad "$@" 2>&1 | tee "$output"; then
            code=0
        else
            statuses=("${PIPESTATUS[@]}")
            code=${statuses[0]}
            if [[ "${statuses[1]}" -ne 0 ]]; then
                echo "::error::Could not capture the Radius deployment output." >&2
                return "${statuses[1]}"
            fi
        fi
        if [[ "$code" -eq 0 ]]; then
            return 0
        fi
        if [[ "$1" != "deploy" || "$attempt" -eq 3 || "$code" -ge 128 ]] ||
            ! jq -Rse '
                capture("(?s)(?:^|\\n)Error: (?<body>\\{.*\\})\\s*$").body
                | fromjson
                | .code == "DeploymentFailed"
                  and any(.. | objects; .code? == "RecipeDeploymentFailed")
                  and ([.. | objects
                        | select(.code? != null and .code != "OK")
                        | select((.details // [] | length) == 0)]
                       | length > 0 and all(.[];
                           .code == "ResourceDeploymentFailure"
                           and (.message | test("connection reset by peer"; "i"))))
            ' "$output" >/dev/null 2>&1; then
            return "$code"
        fi
        echo "::warning::The recipe deployment ended with a connection reset. Reconnecting with a new Radius deploy process (attempt $((attempt + 1))/3)."
        sleep "$((attempt * 2))" || return "$?"
    done
)
