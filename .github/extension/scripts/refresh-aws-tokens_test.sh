#!/bin/bash
# shellcheck disable=SC2016  # the wiring checks match literal action and workflow text

# Tests refresh-aws-tokens.sh without cloud or cluster access.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
readonly REPO_ROOT
readonly SCRIPT="${SCRIPT_DIR}/refresh-aws-tokens.sh"
readonly COMMAND_ACTION="${REPO_ROOT}/.github/extension/actions/run-rad-commands/action.yml"
readonly DELETE_ACTION="${REPO_ROOT}/.github/extension/actions/delete-resource/action.yml"
readonly AWS_COMMAND_WORKFLOW="${REPO_ROOT}/.github/extension/run-rad-commands-aws.yml"
readonly AWS_DELETE_WORKFLOW="${REPO_ROOT}/.github/extension/delete-aws.yml"
readonly AZURE_COMMAND_WORKFLOW="${REPO_ROOT}/.github/extension/run-rad-commands-azure.yml"
readonly AZURE_DELETE_WORKFLOW="${REPO_ROOT}/.github/extension/delete-azure.yml"
readonly POD_TOKEN_FILE="/etc/radius/target-kubeconfig/token"
TEMP_DIR="$(mktemp -d)"
readonly TEMP_DIR
trap 'rm -rf "${TEMP_DIR}"' EXIT

mkdir -p "${TEMP_DIR}/bin" "${TEMP_DIR}/runner"

# Every stub logs its argv so the test can check that no token is ever passed on
# a command line.
cat >"${TEMP_DIR}/bin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"${ARGV_FILE}"
count=0
if [[ -f "${CURL_COUNT_FILE}" ]]; then
    count="$(cat "${CURL_COUNT_FILE}")"
fi
((count += 1))
printf '%s' "${count}" >"${CURL_COUNT_FILE}"
if [[ " ${CURL_FAILURES:-} " == *" ${count} "* ]]; then
    exit 22
fi
printf '{"value":"oidc-token-%s"}\n' "${count}"
EOF

cat >"${TEMP_DIR}/bin/aws" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'aws %s\n' "$*" >>"${ARGV_FILE}"
count=0
if [[ -f "${AWS_COUNT_FILE}" ]]; then
    count="$(cat "${AWS_COUNT_FILE}")"
fi
((count += 1))
printf '%s' "${count}" >"${AWS_COUNT_FILE}"
{
    printf 'static-key=%s\n' "${AWS_ACCESS_KEY_ID:-}"
    printf 'static-secret=%s\n' "${AWS_SECRET_ACCESS_KEY:-}"
    printf 'session-token=%s\n' "${AWS_SESSION_TOKEN:-}"
    printf 'profile=%s\n' "${AWS_PROFILE:-}"
    printf 'role=%s\n' "${AWS_ROLE_ARN:-}"
    printf 'session-name=%s\n' "${AWS_ROLE_SESSION_NAME:-}"
    printf 'web-identity=%s\n' "$(cat "${AWS_WEB_IDENTITY_TOKEN_FILE}")"
} >>"${AWS_ENV_FILE}"
if [[ " ${AWS_FAILURES:-} " == *" ${count} "* ]]; then
    exit 255
fi
printf '{"kind":"ExecCredential","status":{"expirationTimestamp":"2030-01-01T00:14:00Z","token":"eks-token-%s"}}\n' "${count}"
EOF

# `create secret` accepts only radius-system, and prints the Secret's name and
# data so `apply` can record it.
cat >"${TEMP_DIR}/bin/kubectl" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'kubectl %s\n' "$*" >>"${ARGV_FILE}"
case "${1:-}" in
    config)
        kubeconfig=""
        jsonpath=""
        for argument in "$@"; do
            case "${argument}" in
                jsonpath=*) jsonpath="${argument#jsonpath=}" ;;
            esac
        done
        while (($# > 0)); do
            if [[ "$1" == "--kubeconfig" ]]; then
                kubeconfig="$2"
            fi
            shift
        done
        case "${jsonpath}" in
            *.server*) key="server" ;;
            *certificate-authority-data*) key="certificate-authority-data" ;;
            *) exit 1 ;;
        esac
        sed -n "s/^ *${key}: //p" "${kubeconfig}" | head -1
        ;;
    create)
        if [[ "$5 $6" != "--namespace radius-system" ]]; then
            echo "unexpected namespace: $*" >&2
            exit 1
        fi
        printf 'secret=%s\n' "$4"
        for argument in "$@"; do
            case "${argument}" in
                --from-literal=*)
                    exit 1
                    ;;
                --from-file=*)
                    key="${argument#--from-file=}"
                    printf '%s<<\n%s\n>>\n' "${key%%=*}" "$(cat "${key#*=}")"
                    ;;
            esac
        done
        ;;
    apply)
        count=0
        if [[ -f "${APPLY_COUNT_FILE}" ]]; then
            count="$(cat "${APPLY_COUNT_FILE}")"
        fi
        ((count += 1))
        printf '%s' "${count}" >"${APPLY_COUNT_FILE}"
        if [[ " ${APPLY_FAILURES:-} " == *" ${count} "* ]]; then
            cat >/dev/null
            exit 1
        fi
        cat >>"${KUBECTL_APPLY_FILE}"
        ;;
    *)
        exit 1
        ;;
esac
EOF

cat >"${TEMP_DIR}/bin/sleep" <<'EOF'
#!/bin/bash
printf '%s\n' "$1" >>"${SLEEP_FILE}"
EOF

chmod +x "${TEMP_DIR}/bin/curl" "${TEMP_DIR}/bin/aws" \
    "${TEMP_DIR}/bin/kubectl" "${TEMP_DIR}/bin/sleep"

ORIGINAL_PATH="${PATH}"
readonly ORIGINAL_PATH
export PATH="${TEMP_DIR}/bin:${PATH}"
export RUNNER_TEMP="${TEMP_DIR}/runner"
export ACTIONS_ID_TOKEN_REQUEST_TOKEN="request-token"
export ACTIONS_ID_TOKEN_REQUEST_URL="https://oidc.example/token?job=1"
export RADIUS_AWS_ROLE_ARN="arn:aws:iam::111122223333:role/radius-deploy"
export RADIUS_AWS_REGION="us-west-2"
export RADIUS_AWS_EKS_CLUSTER_NAME="demo-cluster"
export RADIUS_TARGET_KUBECONFIG="${TEMP_DIR}/target-kubeconfig"
# The runner's own AWS session must not be used to mint the EKS token.
export AWS_ACCESS_KEY_ID="runner-key"
export AWS_SECRET_ACCESS_KEY="runner-secret"
export AWS_SESSION_TOKEN="runner-session"
export AWS_PROFILE="runner-profile"
export ARGV_FILE="${TEMP_DIR}/argv"
export CURL_COUNT_FILE="${TEMP_DIR}/curl-count"
export AWS_COUNT_FILE="${TEMP_DIR}/aws-count"
export AWS_ENV_FILE="${TEMP_DIR}/aws-env"
export KUBECTL_APPLY_FILE="${TEMP_DIR}/kubectl-apply"
export APPLY_COUNT_FILE="${TEMP_DIR}/apply-count"
export SLEEP_FILE="${TEMP_DIR}/sleeps"
unset AWS_TOKEN_REFRESH_INTERVAL_SECONDS

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

reset() {
    rm -f "${ARGV_FILE}" "${CURL_COUNT_FILE}" "${AWS_COUNT_FILE}" \
        "${AWS_ENV_FILE}" "${KUBECTL_APPLY_FILE}" "${APPLY_COUNT_FILE}" "${SLEEP_FILE}"
    printf 'apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: Q0EtREFUQQ==\n    server: https://eks.example\n  name: eks\ncontexts:\n- context:\n    cluster: eks\n    user: eks-user\n  name: eks\ncurrent-context: eks\nkind: Config\nusers:\n- name: eks-user\n  user:\n    token: old-token\n' \
        >"${RADIUS_TARGET_KUBECONFIG}"
}

sleeps() {
    tr '\n' ' ' <"${SLEEP_FILE}" | sed 's/ $//'
}

expected_kubeconfig() {
    printf 'apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: Q0EtREFUQQ==\n    server: https://eks.example\n  name: eks\ncontexts:\n- context:\n    cluster: eks\n    user: eks-user\n  name: eks\ncurrent-context: eks\nkind: Config\nusers:\n- name: eks-user\n  user:\n    token: %s\n    tokenFile: %s' \
        "$1" "${POD_TOKEN_FILE}"
}

expected_updates() {
    local oidc="$1"
    local eks="$2"

    printf 'secret=aws-oidc-token\ntoken<<\n%s\n>>\n' "${oidc}"
    printf 'secret=target-kubeconfig\nkubeconfig<<\n%s\n>>\ntoken<<\n%s\n>>\n' \
        "$(expected_kubeconfig "${eks}")" "${eks}"
}

check_no_token_leak() {
    local output="$1"

    if [[ "${output}" == *"oidc-token-"* || "${output}" == *"eks-token-"* ||
        "${output}" == *"request-token"* ]]; then
        fail "a token value leaked to the output: ${output}"
    fi
    if grep -q -e 'oidc-token-' -e 'eks-token-' "${ARGV_FILE}"; then
        fail "a token value was passed on a command line"
    fi
}

check_runner_files_removed() {
    if [[ -n "$(ls -A "${RUNNER_TEMP}")" ]]; then
        fail "expected the token files to be removed from RUNNER_TEMP"
    fi
}

# Stops a watcher and returns its exit status, or 124 after force-stopping one
# still running after the given seconds, so a stuck watcher fails the test
# instead of hanging it.
cancel_watcher() {
    local pid="$1"
    local limit="$2"
    local status=0

    kill "${pid}"
    for _ in $(seq 1 $((limit * 20))); do
        kill -0 "${pid}" 2>/dev/null || break
        /bin/sleep 0.05
    done
    if kill -0 "${pid}" 2>/dev/null; then
        kill -KILL "${pid}" 2>/dev/null || true
        wait "${pid}" 2>/dev/null || true
        return 124
    fi
    wait "${pid}" 2>/dev/null || status=$?
    return "${status}"
}

# --prepare refreshes both tokens once.
reset
output="$(bash "${SCRIPT}" --prepare 2>&1)" || fail "expected prepare to succeed, got: ${output}"
[[ "${output}" == "AWS tokens refreshed." ]] || fail "unexpected prepare output: ${output}"
[[ "$(cat "${KUBECTL_APPLY_FILE}")" == "$(expected_updates oidc-token-1 eks-token-1)" ]] ||
    fail "expected the OIDC and kubeconfig Secrets with both EKS token forms, got:
$(cat "${KUBECTL_APPLY_FILE}")"
[[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "$(expected_kubeconfig eks-token-1)" ]] ||
    fail "expected the runner kubeconfig to match the Secret's kubeconfig"
grep -Fq "curl -fsS --connect-timeout 5 --max-time 20 -H Authorization: bearer request-token https://oidc.example/token?job=1&audience=sts.amazonaws.com" \
    "${ARGV_FILE}" || fail "expected the OIDC request to use the STS audience and finite timeouts"
grep -Fq "aws eks get-token --cluster-name demo-cluster --region us-west-2 --cli-connect-timeout 5 --cli-read-timeout 20 --output json" \
    "${ARGV_FILE}" || fail "expected the EKS token for the configured cluster and region"
[[ "$(grep -c -- '--request-timeout=20s' "${ARGV_FILE}")" == "2" ]] ||
    fail "expected every Secret update to have a finite request timeout"
expected_env=$'static-key=\nstatic-secret=\nsession-token=\nprofile=\n'
expected_env+=$'role=arn:aws:iam::111122223333:role/radius-deploy\n'
expected_env+=$'session-name=radius-token-refresh\nweb-identity=oidc-token-1'
[[ "$(cat "${AWS_ENV_FILE}")" == "${expected_env}" ]] ||
    fail "expected the EKS token to come from web identity with the new GitHub token, got:
$(cat "${AWS_ENV_FILE}")"
if grep -q 'rollout' "${ARGV_FILE}"; then
    fail "expected no pod restarts; the pods re-read the mounted Secrets"
fi
check_no_token_leak "${output}"
check_runner_files_removed

# --watch refreshes every 2 minutes and retries a failure after 15 seconds.
reset
output="$(AWS_FAILURES="1" bash "${SCRIPT}" --watch 3 2>&1)"
[[ "$(sleeps)" == "120 15 120" ]] ||
    fail "expected a 15-second retry after a failed EKS refresh, got '$(sleeps)'"
[[ "$(grep -c '^::warning::AWS token refresh failed; retrying\.$' <<<"${output}")" == "1" ]] ||
    fail "expected one failure warning, got: ${output}"
[[ "$(grep -c '^AWS tokens refreshed\.$' <<<"${output}")" == "2" ]] ||
    fail "expected two refresh messages, got: ${output}"
[[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "$(expected_kubeconfig eks-token-3)" ]] ||
    fail "expected the latest EKS token in the runner kubeconfig"
[[ "$(grep -c '^web-identity=' "${AWS_ENV_FILE}")" == "3" &&
    "$(tail -1 "${AWS_ENV_FILE}")" == "web-identity=oidc-token-3" ]] ||
    fail "expected each EKS refresh to use that cycle's GitHub token"
check_no_token_leak "${output}"
check_runner_files_removed

# A failed GitHub token request skips the EKS refresh and retries.
reset
CURL_FAILURES="1" bash "${SCRIPT}" --watch 2 >/dev/null 2>&1
[[ "$(sleeps)" == "120 15" ]] || fail "expected a retry after a failed OIDC request"
[[ "$(cat "${AWS_COUNT_FILE}")" == "1" ]] ||
    fail "expected no EKS refresh without a new GitHub token"

# Without an EKS cluster only the GitHub token is refreshed.
reset
before="$(cat "${RADIUS_TARGET_KUBECONFIG}")"
RADIUS_AWS_EKS_CLUSTER_NAME="" RADIUS_TARGET_KUBECONFIG="" \
    bash "${SCRIPT}" --prepare >/dev/null
[[ "$(cat "${KUBECTL_APPLY_FILE}")" == $'secret=aws-oidc-token\ntoken<<\noidc-token-1\n>>' ]] ||
    fail "expected only the OIDC Secret without an EKS cluster"
[[ ! -f "${AWS_COUNT_FILE}" ]] || fail "expected no EKS token without an EKS cluster"
[[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "${before}" ]] ||
    fail "expected the kubeconfig to stay unchanged without an EKS cluster"

# A failed prepare explains what to check, and leaves the kubeconfig and the
# target-kubeconfig Secret alone.
reset
before="$(cat "${RADIUS_TARGET_KUBECONFIG}")"
if output="$(AWS_FAILURES="1" bash "${SCRIPT}" --prepare 2>&1)"; then
    fail "expected prepare to fail when the EKS token cannot be minted"
fi
[[ "${output}" == *"Could not refresh the GitHub or EKS token."* ]] ||
    fail "expected an actionable prepare error, got: ${output}"
[[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "${before}" ]] ||
    fail "expected a failed refresh to keep the previous kubeconfig"
[[ "$(cat "${KUBECTL_APPLY_FILE}")" == $'secret=aws-oidc-token\ntoken<<\noidc-token-1\n>>' ]] ||
    fail "expected only the OIDC Secret update when the EKS token cannot be minted"
check_runner_files_removed

# A failed Secret update fails prepare and keeps the previous runner kubeconfig.
# The first apply updates aws-oidc-token and the second target-kubeconfig.
for failed_apply in 1 2; do
    reset
    before="$(cat "${RADIUS_TARGET_KUBECONFIG}")"
    if output="$(APPLY_FAILURES="${failed_apply}" bash "${SCRIPT}" --prepare 2>&1)"; then
        fail "expected prepare to fail when Secret update ${failed_apply} fails"
    fi
    [[ "${output}" == *"Could not refresh the GitHub or EKS token."* ]] ||
        fail "expected an actionable error when Secret update ${failed_apply} fails, got: ${output}"
    [[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "${before}" ]] ||
        fail "expected failed Secret update ${failed_apply} to keep the previous kubeconfig"
    if [[ "${failed_apply}" == "1" && -f "${AWS_COUNT_FILE}" ]]; then
        fail "expected no EKS token after the OIDC Secret update failed"
    fi
    check_runner_files_removed
done

# A failed OIDC Secret update skips the EKS refresh and retries after 15 seconds.
reset
output="$(APPLY_FAILURES="1" bash "${SCRIPT}" --watch 3 2>&1)"
[[ "$(sleeps)" == "120 15 120" ]] ||
    fail "expected a 15-second retry after a failed OIDC Secret update, got '$(sleeps)'"
[[ "$(grep -c '^::warning::AWS token refresh failed; retrying\.$' <<<"${output}")" == "1" ]] ||
    fail "expected one failure warning after a failed OIDC Secret update, got: ${output}"
[[ "$(cat "${AWS_COUNT_FILE}")" == "2" ]] ||
    fail "expected no EKS refresh in the cycle whose OIDC Secret update failed"
[[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "$(expected_kubeconfig eks-token-2)" ]] ||
    fail "expected the retried refreshes to update the runner kubeconfig"
check_runner_files_removed

# A failed target-kubeconfig Secret update keeps the previous runner kubeconfig,
# and the retry 15 seconds later writes the new token to both.
reset
before="$(cat "${RADIUS_TARGET_KUBECONFIG}")"
APPLY_FAILURES="2" bash "${SCRIPT}" --watch 1 >/dev/null 2>&1
[[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "${before}" ]] ||
    fail "expected a failed target-kubeconfig Secret update to keep the runner kubeconfig"
reset
APPLY_FAILURES="2" bash "${SCRIPT}" --watch 2 >/dev/null 2>&1
[[ "$(sleeps)" == "120 15" ]] ||
    fail "expected a 15-second retry after a failed target-kubeconfig Secret update, got '$(sleeps)'"
[[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "$(expected_kubeconfig eks-token-2)" ]] ||
    fail "expected the retry to write its EKS token to the runner kubeconfig"
expected_apply="$(
    printf 'secret=aws-oidc-token\ntoken<<\noidc-token-1\n>>\n'
    expected_updates oidc-token-2 eks-token-2
)"
[[ "$(cat "${KUBECTL_APPLY_FILE}")" == "${expected_apply}" ]] ||
    fail "expected the retry to write its EKS token to the target-kubeconfig Secret, got:
$(cat "${KUBECTL_APPLY_FILE}")"
check_runner_files_removed

# Missing configuration fails before any request.
reset
for variable in RADIUS_AWS_ROLE_ARN RADIUS_AWS_REGION RADIUS_TARGET_KUBECONFIG; do
    if output="$(env "${variable}=" bash "${SCRIPT}" --prepare 2>&1)"; then
        fail "expected prepare to fail without ${variable}"
    fi
    [[ "${output}" == "Missing required environment variable: ${variable}" ]] ||
        fail "unexpected error without ${variable}: ${output}"
done
if output="$(RADIUS_TARGET_KUBECONFIG="${TEMP_DIR}/missing" bash "${SCRIPT}" --prepare 2>&1)"; then
    fail "expected prepare to fail without the EKS kubeconfig"
fi
[[ "${output}" == *"No EKS kubeconfig at RADIUS_TARGET_KUBECONFIG"* ]] ||
    fail "unexpected error without the EKS kubeconfig: ${output}"
[[ ! -f "${CURL_COUNT_FILE}" ]] || fail "expected no token request with missing configuration"
for interval in 0 -1 abc; do
    if output="$(AWS_TOKEN_REFRESH_INTERVAL_SECONDS="${interval}" bash "${SCRIPT}" --watch 1 2>&1)"; then
        fail "expected refresh interval '${interval}' to fail"
    fi
    [[ "${output}" == "AWS_TOKEN_REFRESH_INTERVAL_SECONDS must be a positive integer." ]] ||
        fail "unexpected error for refresh interval '${interval}': ${output}"
done
[[ ! -f "${CURL_COUNT_FILE}" ]] || fail "expected no token request with an invalid refresh interval"
for missing in server certificate-authority-data; do
    sed -i.bak "/${missing}:/d" "${RADIUS_TARGET_KUBECONFIG}"
    rm -f "${RADIUS_TARGET_KUBECONFIG}.bak"
    if output="$(bash "${SCRIPT}" --prepare 2>&1)"; then
        fail "expected prepare to fail without the kubeconfig ${missing}"
    fi
    [[ "${output}" == "The EKS kubeconfig at RADIUS_TARGET_KUBECONFIG has no cluster server or certificate authority." ]] ||
        fail "unexpected error without the kubeconfig ${missing}: ${output}"
    [[ ! -f "${CURL_COUNT_FILE}" ]] || fail "expected no token request without the kubeconfig ${missing}"
    reset
done
if bash "${SCRIPT}" --watch abc >/dev/null 2>&1; then
    fail "expected an invalid refresh count to fail"
fi
if bash "${SCRIPT}" >/dev/null 2>&1; then
    fail "expected a missing mode to fail"
fi

# A cancelled watcher stops without waiting for its interval and removes its
# token files.
reset
idle_bin="${TEMP_DIR}/idle-bin"
mkdir -p "${idle_bin}"
cp "${TEMP_DIR}/bin/curl" "${TEMP_DIR}/bin/aws" "${TEMP_DIR}/bin/kubectl" "${idle_bin}/"
PATH="${idle_bin}:${ORIGINAL_PATH}" bash "${SCRIPT}" --watch &
watcher_pid=$!
/bin/sleep 0.5
status=0
cancel_watcher "${watcher_pid}" 3 || status=$?
[[ "${status}" == "0" ]] ||
    fail "expected a cancelled watcher to stop without waiting for its interval, got ${status}"
check_runner_files_removed

# A watcher cancelled during a call cannot run its TERM trap until that call
# returns, so it stops once the call ends, which the call's own timeout bounds.
# It must then exit without starting another call, leave no child running, and
# leave no token outside its token directory. Each wrapper holds the command it
# names for BLOCK_SECONDS, then runs the normal stub.
readonly BLOCK_SECONDS=2
busy_bin="${TEMP_DIR}/busy-bin"
mkdir -p "${busy_bin}"
for command in curl aws kubectl cp mv; do
    target="${TEMP_DIR}/bin/${command}"
    [[ -x "${target}" ]] || target="/bin/${command}"
    cat >"${busy_bin}/${command}" <<EOF
#!/bin/bash
pattern="^(\${BLOCK_IN})( |\$)"
if [[ "${command} \${1:-}" =~ \${pattern} ]]; then
    printf '%s' "\$\$" >"\${BLOCK_PID_FILE}"
    /bin/sleep ${BLOCK_SECONDS}
fi
exec "${target}" "\$@"
EOF
    chmod +x "${busy_bin}/${command}"
done
export BLOCK_PID_FILE="${TEMP_DIR}/blocked-pid"

# Each case is the blocked command pattern, the last call the stubs should log,
# and the runner kubeconfig left behind. "cp|mv" blocks the kubeconfig write,
# which follows the concurrent `kubectl create | kubectl apply` of its Secret.
cancel_cases=(
    "curl;curl;old"
    "aws;aws;old"
    "kubectl apply;kubectl apply;old"
    "cp|mv;kubectl;new"
)
for cancel_case in "${cancel_cases[@]}"; do
    IFS=';' read -r blocked last_call kubeconfig_state <<<"${cancel_case}"
    reset
    rm -f "${BLOCK_PID_FILE}"
    before="$(cat "${RADIUS_TARGET_KUBECONFIG}")"
    BLOCK_IN="${blocked}" PATH="${busy_bin}:${TEMP_DIR}/bin:${ORIGINAL_PATH}" \
        bash "${SCRIPT}" --watch >/dev/null 2>&1 &
    watcher_pid=$!
    for _ in $(seq 1 100); do
        [[ -s "${BLOCK_PID_FILE}" ]] && break
        /bin/sleep 0.05
    done
    [[ -s "${BLOCK_PID_FILE}" ]] || fail "expected the watcher to call ${blocked}"
    blocked_pid="$(cat "${BLOCK_PID_FILE}")"
    status=0
    cancel_watcher "${watcher_pid}" $((BLOCK_SECONDS + 3)) || status=$?
    [[ "${status}" == "0" ]] ||
        fail "expected a watcher cancelled during ${blocked} to exit cleanly once that call returned, got ${status}"
    if kill -0 "${blocked_pid}" 2>/dev/null; then
        fail "expected no ${blocked} process to remain after the watcher stopped"
    fi
    [[ "$(tail -n 1 "${ARGV_FILE}")" == "${last_call}"* ]] ||
        fail "expected no call after ${blocked} once the watcher was cancelled, last was: $(tail -n 1 "${ARGV_FILE}")"
    if [[ "${kubeconfig_state}" == "old" ]]; then
        expected="${before}"
    else
        expected="$(expected_kubeconfig eks-token-1)"
    fi
    [[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "${expected}" ]] ||
        fail "expected a complete runner kubeconfig after cancelling during ${blocked}"
    if compgen -G "${RADIUS_TARGET_KUBECONFIG}?*" >/dev/null; then
        fail "expected no staged kubeconfig next to the runner kubeconfig after cancelling during ${blocked}"
    fi
    check_runner_files_removed
done

# The actions declare the AWS inputs and pass them to their step. How the step
# runs the refresher is tested in refresh-aws-tokens-actions_test.sh.
for action in "${COMMAND_ACTION}" "${DELETE_ACTION}"; do
    name="$(basename "$(dirname "${action}")")"
    for input in aws-role-arn aws-eks-cluster-name aws-region; do
        grep -Fq "  ${input}:" "${action}" || fail "expected ${name} to declare ${input}"
    done
    if ! grep -Fq 'RADIUS_AWS_ROLE_ARN: ${{ inputs.aws-role-arn }}' "${action}" ||
        ! grep -Fq 'RADIUS_AWS_EKS_CLUSTER_NAME: ${{ inputs.aws-eks-cluster-name }}' "${action}" ||
        ! grep -Fq 'RADIUS_AWS_REGION: ${{ inputs.aws-region }}' "${action}"; then
        fail "expected ${name} to pass its AWS inputs to the refresher"
    fi
done

# The AWS workflows pass the deploy role, cluster, and region to the actions.
for workflow in "${AWS_COMMAND_WORKFLOW}" "${AWS_DELETE_WORKFLOW}"; do
    name="$(basename "${workflow}")"
    grep -Fq 'aws-role-arn: ${{ vars.AWS_ROLE_ARN }}' "${workflow}" ||
        fail "expected ${name} to enable the AWS token refresh"
    grep -Fq 'aws-eks-cluster-name: ${{ vars.AWS_EKS_CLUSTER_NAME }}' "${workflow}" ||
        fail "expected ${name} to pass the EKS cluster"
    grep -Fq 'aws-region: ${{ vars.AWS_REGION }}' "${workflow}" ||
        fail "expected ${name} to pass the region"
done

for workflow in "${AZURE_COMMAND_WORKFLOW}" "${AZURE_DELETE_WORKFLOW}"; do
    if grep -q 'aws-role-arn:' "${workflow}"; then
        fail "expected $(basename "${workflow}") not to start the AWS refresher"
    fi
done

echo "refresh-aws-tokens tests passed"
