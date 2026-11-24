#!/usr/bin/env bash

set -euo pipefail

output="$(mktemp)"
trap 'rm -f "$output"' EXIT

# The action caps this whole read-only check, including retries, at 120 seconds.
for delay in 1 2 4 8 0; do
    if kubectl wait --for=condition=Ready node --all --timeout=120s >"$output" 2>&1; then
        cat "$output"
        exit 0
    else
        code=$?
    fi
    cat "$output" >&2
    if [[ "$code" -ne 1 || "$delay" -eq 0 ||
        "$(tail -n 1 "$output")" != "Error from server (ServiceUnavailable): the server is currently unable to handle the request" ]]; then
        exit "$code"
    fi
    echo "Control-plane API discovery is temporarily unavailable; retrying in ${delay}s." >&2
    sleep "$delay"
done
