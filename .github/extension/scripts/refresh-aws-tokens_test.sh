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

# `create secret` prints the Secret's name and data so `apply` can record it.
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
export SLEEP_FILE="${TEMP_DIR}/sleeps"
unset AWS_TOKEN_REFRESH_INTERVAL_SECONDS

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

reset() {
    rm -f "${ARGV_FILE}" "${CURL_COUNT_FILE}" "${AWS_COUNT_FILE}" \
        "${AWS_ENV_FILE}" "${KUBECTL_APPLY_FILE}" "${SLEEP_FILE}"
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

# --prepare refreshes both tokens once.
reset
output="$(bash "${SCRIPT}" --prepare 2>&1)"
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

# A failed prepare explains what to check and leaves the kubeconfig alone.
reset
before="$(cat "${RADIUS_TARGET_KUBECONFIG}")"
if output="$(AWS_FAILURES="1" bash "${SCRIPT}" --prepare 2>&1)"; then
    fail "expected prepare to fail when the EKS token cannot be minted"
fi
[[ "${output}" == *"Could not refresh the GitHub or EKS token."* ]] ||
    fail "expected an actionable prepare error, got: ${output}"
[[ "$(cat "${RADIUS_TARGET_KUBECONFIG}")" == "${before}" ]] ||
    fail "expected a failed refresh to keep the previous kubeconfig"
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
kill "${watcher_pid}"
stopped=0
for _ in $(seq 1 60); do
    if ! kill -0 "${watcher_pid}" 2>/dev/null; then
        stopped=1
        break
    fi
    /bin/sleep 0.05
done
wait "${watcher_pid}" 2>/dev/null || true
[[ "${stopped}" == "1" ]] || fail "expected a cancelled watcher to stop without waiting for its interval"
check_runner_files_removed

# The actions start the AWS refresher only when given the deploy role, and the
# AWS workflows pass it and point the kubeconfig at the refreshed token key.
for action in "${COMMAND_ACTION}" "${DELETE_ACTION}"; do
    name="$(basename "$(dirname "${action}")")"
    for input in aws-role-arn aws-eks-cluster-name aws-region; do
        grep -Fq "  ${input}:" "${action}" || fail "expected ${name} to declare ${input}"
    done
    grep -Fq '[ -n "$RADIUS_AWS_ROLE_ARN" ]' "${action}" ||
        fail "expected ${name} to refresh AWS tokens only with a deploy role"
    grep -Fq 'scripts/refresh-aws-tokens.sh"' "${action}" ||
        fail "expected ${name} to use the AWS refresher"
    grep -Fq 'bash "$AWS_TOKEN_REFRESH_SCRIPT" --prepare' "${action}" ||
        fail "expected ${name} to refresh AWS tokens before running"
    grep -Fq 'bash "$AWS_TOKEN_REFRESH_SCRIPT" --watch &' "${action}" ||
        fail "expected ${name} to start the AWS token watcher"
done

validation_line="$(grep -n 'if ! is_allowed "$cmd"' "${COMMAND_ACTION}" | cut -d: -f1)"
aws_start_line="$(grep -n 'start_aws_token_refresh; then' "${COMMAND_ACTION}" |
    head -1 | cut -d: -f1)"
if [[ -z "${validation_line}" || -z "${aws_start_line}" ||
    "${aws_start_line}" -le "${validation_line}" ]]; then
    fail "expected command validation before the AWS token refresh"
fi
[[ "$(grep -c 'start_aws_token_refresh; then' "${COMMAND_ACTION}")" == "2" ]] ||
    fail "expected custom commands and the default deploy to start the AWS refresher"

for workflow in "${AWS_COMMAND_WORKFLOW}" "${AWS_DELETE_WORKFLOW}"; do
    name="$(basename "${workflow}")"
    grep -Fq 'aws-role-arn: ${{ vars.AWS_ROLE_ARN }}' "${workflow}" ||
        fail "expected ${name} to enable the AWS token refresh"
    grep -Fq 'aws-eks-cluster-name: ${{ vars.AWS_EKS_CLUSTER_NAME }}' "${workflow}" ||
        fail "expected ${name} to pass the EKS cluster"
    grep -Fq 'aws-region: ${{ vars.AWS_REGION }}' "${workflow}" ||
        fail "expected ${name} to pass the region"
    grep -Fq "tokenFile: ${POD_TOKEN_FILE}" "${workflow}" ||
        fail "expected ${name} to point the kubeconfig at the refreshed token key"
    grep -Fq 'SECRET_FILES+=(--from-file=token="$TOKEN_FILE")' "${workflow}" ||
        fail "expected ${name} to store the EKS token key in the target-kubeconfig Secret"
done

for workflow in "${AZURE_COMMAND_WORKFLOW}" "${AZURE_DELETE_WORKFLOW}"; do
    if grep -q 'aws-role-arn:' "${workflow}"; then
        fail "expected $(basename "${workflow}") not to start the AWS refresher"
    fi
done

echo "refresh-aws-tokens tests passed"
