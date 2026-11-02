#!/bin/bash

# Shared watch loop for the cloud token refreshers. Source this file, then call
# watch_token_refresh with a refresh function, the messages to log after a
# successful and a failed refresh, the refresh interval in seconds, and the
# number of refreshes to run (0 runs until the watcher is stopped).

# A failed refresh is retried after this many seconds, instead of waiting a full
# interval, until a refresh succeeds.
readonly TOKEN_REFRESH_RETRY_SECONDS=15
TOKEN_REFRESH_SLEEP_PID=""

# The watcher is idle between refreshes and bash defers traps until the current
# foreground command returns, so cancel the sleep instead of waiting it out.
stop_token_refresh_watch() {
    if [[ -n "${TOKEN_REFRESH_SLEEP_PID}" ]]; then
        kill "${TOKEN_REFRESH_SLEEP_PID}" 2>/dev/null || true
    fi
    exit 0
}

watch_token_refresh() {
    local refresh="$1"
    local success_message="$2"
    local failure_message="$3"
    local interval="$4"
    local max_refreshes="$5"
    local retry_delay="${TOKEN_REFRESH_RETRY_SECONDS}"
    local delay="${interval}"
    local refreshes=0

    if ((interval < retry_delay)); then
        retry_delay="${interval}"
    fi

    trap stop_token_refresh_watch TERM INT
    while true; do
        sleep "${delay}" &
        TOKEN_REFRESH_SLEEP_PID=$!
        wait "${TOKEN_REFRESH_SLEEP_PID}" || true
        TOKEN_REFRESH_SLEEP_PID=""
        if "${refresh}"; then
            echo "${success_message}"
            delay="${interval}"
        else
            echo "::warning::${failure_message}" >&2
            delay="${retry_delay}"
        fi

        ((refreshes += 1))
        if ((max_refreshes > 0 && refreshes >= max_refreshes)); then
            break
        fi
    done
}
