#!/bin/bash

# Tests azure-aks-token.sh, and the AKS token refresh in
# refresh-azure-oidc-token.sh, without cloud or cluster access. The kubectl,
# curl, and az fakes record every call and reject any call they do not model.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly AKS_SCRIPT="${SCRIPT_DIR}/azure-aks-token.sh"
readonly REFRESH_SCRIPT="${SCRIPT_DIR}/refresh-azure-oidc-token.sh"
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

readonly SERVER_ID="11111111-2222-3333-4444-555555555555"
readonly DEFAULT_SERVER_ID="6dae42f8-4368-4678-94ff-3960e28e3630"
readonly CLIENT_ID="aaaaaaaa-0000-0000-0000-000000000001"
readonly TENANT_ID="bbbbbbbb-0000-0000-0000-000000000002"
readonly AUTHORITY="https://login.microsoftonline.com"
readonly POD_TOKEN_FILE="/etc/radius/target-kubeconfig/token"
readonly ASSERTION_TYPE="urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer"

export FAKE_CALLS="${TEST_ROOT}/calls"
export FAKE_REJECTS="${TEST_ROOT}/rejects"
export FAKE_REQUEST_TOKEN="fixture-request-token"
export FAKE_ASSERTION_PREFIX="fixture-assertion"
export FAKE_TOKEN_PREFIX="fixture-aks-token"
export FAKE_AUTHORITY="${AUTHORITY}"
export FAKE_TENANT_ID="${TENANT_ID}"
export FAKE_CLIENT_ID="${CLIENT_ID}"
export ACTIONS_ID_TOKEN_REQUEST_TOKEN="${FAKE_REQUEST_TOKEN}"
export ACTIONS_ID_TOKEN_REQUEST_URL="https://oidc.example/token?job=1"
: >"${FAKE_CALLS}"
: >"${FAKE_REJECTS}"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "ok - $*"
}

# --- Fakes -------------------------------------------------------------------

mkdir -p "${TEST_ROOT}/bin"

cat >"${TEST_ROOT}/bin/fake-lib.sh" <<'EOF'
record_call() {
    local name="$1"
    shift
    { printf '%s' "${name}"; printf ' %q' "$@"; echo; } | tee -a "${FAKE_CALLS}" >>"${FAKE_CASE_CALLS}"
}

reject() {
    echo "$*" >>"${FAKE_REJECTS}"
    echo "fake: unexpected call: $*" >&2
    exit 97
}

# refresh-azure-oidc-token.sh refreshes the azure-oidc-token Secret as it did
# before AKS support, with the request token in a curl header argument and the
# GitHub token in --from-literal. Those calls are kept out of FAKE_CALLS, which
# the final check scans for secrets on command lines.
record_existing_refresh_call() {
    local name="$1"
    shift
    { printf '%s' "${name}"; printf ' %q' "$@"; echo; } >>"${FAKE_CASE_CALLS}"
}

next_count() {
    local file="${FAKE_STATE}/$1-count" count=0
    if [[ -f "${file}" ]]; then
        count="$(cat "${file}")"
    fi
    ((count += 1))
    printf '%s' "${count}" >"${file}"
    printf '%s' "${count}"
}
EOF

cat >"${TEST_ROOT}/bin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/fake-lib.sh"
existing_refresh=0
if [[ "${1:-}" == "-fsS" ]]; then
    existing_refresh=1
    record_existing_refresh_call curl "$@"
else
    record_call curl "$@"
fi

out="" format="" header_file="" data_file="" url="" fail_on_status=0 header_argument=0
while (($#)); do
    case "$1" in
        -sS) ;;
        -fsS) fail_on_status=1 ;;
        --connect-timeout | --max-time)
            [[ "${2:-}" =~ ^[0-9]+$ ]] || reject "curl timeout $*"
            shift
            ;;
        -o) out="$2"; shift ;;
        -w) format="$2"; shift ;;
        -H)
            case "$2" in
                @*) header_file="${2#@}" ;;
                "Authorization: bearer ${FAKE_REQUEST_TOKEN}")
                    ((existing_refresh)) || reject "curl header on the command line"
                    header_argument=1
                    ;;
                "Content-Type: application/x-www-form-urlencoded") ;;
                *) reject "curl header on the command line" ;;
            esac
            shift
            ;;
        --data-binary)
            [[ "$2" == @* ]] || reject "curl data on the command line"
            data_file="${2#@}"
            shift
            ;;
        https://*)
            [[ -z "${url}" ]] || reject "curl second URL"
            url="$1"
            ;;
        *) reject "curl argument $1" ;;
    esac
    shift
done
[[ -z "${format}" || "${format}" == '%{http_code}' ]] || reject "curl format ${format}"

if [[ "${url}" == "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=api://AzureADTokenExchange" ]]; then
    [[ (-n "${header_file}" || "${header_argument}" == 1) && -z "${data_file}" ]] ||
        reject "OIDC request shape"
    [[ -z "${header_file}" || "$(cat "${header_file}")" == "Authorization: bearer ${FAKE_REQUEST_TOKEN}" ]] ||
        reject "OIDC request header"
    count="$(next_count oidc)"
    status="${FAKE_OIDC_STATUS:-200}"
    body="{\"value\":\"${FAKE_ASSERTION_PREFIX}-${count}\"}"
elif [[ "${url}" == "${FAKE_AUTHORITY}/${FAKE_TENANT_ID}/oauth2/v2.0/token" ]]; then
    [[ -n "${data_file}" && -z "${header_file}" ]] || reject "token request shape"
    assertion="${FAKE_ASSERTION_PREFIX}-$(cat "${FAKE_STATE}/oidc-count")"
    expected="grant_type=client_credentials&client_id=${FAKE_CLIENT_ID}"
    expected+="&scope=${FAKE_EXPECTED_SERVER_ID}%2F.default"
    expected+="&client_assertion_type=${FAKE_ASSERTION_TYPE}"
    expected+="&client_assertion=${assertion}"
    [[ "$(cat "${data_file}")" == "${expected}" ]] || reject "token request body"
    count="$(next_count entra)"
    status="${FAKE_ENTRA_STATUS:-200}"
    if [[ -n "${FAKE_ENTRA_BODY:-}" ]]; then
        body="${FAKE_ENTRA_BODY}"
    else
        body="{\"token_type\":\"Bearer\",\"expires_in\":3599,\"access_token\":\"${FAKE_TOKEN_PREFIX}-${count}\"}"
    fi
else
    reject "curl URL ${url}"
fi

if [[ -n "${out}" ]]; then
    printf '%s' "${body}" >"${out}"
elif [[ "${status}" == "200" ]]; then
    printf '%s' "${body}"
fi
if [[ -n "${format}" ]]; then
    printf '%s' "${status}"
fi
if ((fail_on_status)) && [[ "${status}" != "200" ]]; then
    exit 22
fi
EOF

cat >"${TEST_ROOT}/bin/kubectl" <<'EOF'
#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/fake-lib.sh"
if [[ " $* " == *" --from-literal=azure-identity-token="* ]]; then
    record_existing_refresh_call kubectl "$@"
else
    record_call kubectl "$@"
fi

kubeconfig=""
if [[ "${1:-}" == "--kubeconfig" ]]; then
    kubeconfig="$2"
    shift 2
fi

case "$*" in
    "config view --raw --minify -o json")
        # Like kubectl, read the default kubeconfig when --kubeconfig is absent.
        file="${kubeconfig:-${KUBECONFIG:-}}"
        [[ -n "${file}" ]] || reject "kubectl config view without a kubeconfig"
        [[ -z "${FAKE_KUBECTL_VIEW_FAILS:-}" ]] || exit 1
        cat "${file}"
        ;;
    "config view --raw --kubeconfig "*)
        [[ -z "${kubeconfig}" ]] || reject "kubectl render shape"
        cat "$5"
        ;;
    "create secret generic "*" --namespace radius-system "*"--dry-run=client -o yaml")
        [[ -z "${kubeconfig}" ]] || reject "kubectl create shape"
        echo "secret $4"
        for argument in "$@"; do
            case "${argument}" in
                --from-file=*=*)
                    pair="${argument#--from-file=}"
                    printf '%s=%s\n' "${pair%%=*}" "$(cat "${pair#*=}")"
                    ;;
                --from-literal=azure-identity-token=*) printf '%s\n' "${argument#--from-literal=}" ;;
                --from-literal=*) reject "kubectl secret value on the command line" ;;
            esac
        done
        ;;
    "apply --request-timeout=20s -f -" | "apply -f -")
        [[ -z "${FAKE_KUBECTL_APPLY_FAILS:-}" ]] || exit 1
        cat >>"${FAKE_APPLIED}"
        echo "---" >>"${FAKE_APPLIED}"
        ;;
    "rollout restart deployment/"*" --namespace radius-system" | \
        "rollout status deployment/"*" --namespace radius-system --timeout=300s" | \
        "rollout restart deployment/"*" -n radius-system" | \
        "rollout status deployment/"*" -n radius-system --timeout=300s") ;;
    *) reject "kubectl $*" ;;
esac
EOF

cat >"${TEST_ROOT}/bin/az" <<'EOF'
#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/fake-lib.sh"
record_call az "$@"
[[ "$*" == "cloud show --query endpoints.activeDirectory --output tsv" ]] || reject "az $*"
echo "${FAKE_AUTHORITY}/"
EOF

cat >"${TEST_ROOT}/bin/sleep" <<'EOF'
#!/bin/bash
exit 0
EOF

chmod +x "${TEST_ROOT}/bin/curl" "${TEST_ROOT}/bin/kubectl" \
    "${TEST_ROOT}/bin/az" "${TEST_ROOT}/bin/sleep"
export PATH="${TEST_ROOT}/bin:${PATH}"
export FAKE_ASSERTION_TYPE="${ASSERTION_TYPE}"

# --- Fixtures ----------------------------------------------------------------

kubelogin_kubeconfig() {
    local args="$1"
    jq -n --argjson args "${args}" '{
        apiVersion: "v1", kind: "Config", "current-context": "aks",
        clusters: [{name: "aks", cluster: {
            server: "https://aks.example.test:443",
            "certificate-authority-data": "Q0EtREFUQQ=="}}],
        contexts: [{name: "aks", context: {cluster: "aks", user: "clusterUser"}}],
        users: [{name: "clusterUser", user: {exec: {
            apiVersion: "client.authentication.k8s.io/v1beta1",
            command: "kubelogin", args: $args,
            interactiveMode: "IfAvailable", provideClusterInfo: false}}}]
    }'
}

readonly KUBELOGIN_ARGS="[\"get-token\",\"--environment\",\"AzurePublicCloud\",\"--server-id\",\"${SERVER_ID}\",\"--client-id\",\"80faf920-1908-4b52-b5ef-a8e7bedfc67a\",\"--tenant-id\",\"${TENANT_ID}\",\"--login\",\"devicecode\"]"

certificate_kubeconfig() {
    jq -n '{
        apiVersion: "v1", kind: "Config", "current-context": "cert",
        clusters: [{name: "cert", cluster: {
            server: "https://cert.example.test:443",
            "certificate-authority-data": "Q0EtREFUQQ=="}}],
        contexts: [{name: "cert", context: {cluster: "cert", user: "clusterUser"}}],
        users: [{name: "clusterUser", user: {
            "client-certificate-data": "Q0VSVA==",
            "client-key-data": "S0VZ",
            token: "certificate-cluster-token"}}]
    }'
}

# --- Case helpers ------------------------------------------------------------

new_case() {
    CASE_DIR="$(mktemp -d "${TEST_ROOT}/case.XXXXXX")"
    export FAKE_STATE="${CASE_DIR}/state"
    export FAKE_CASE_CALLS="${CASE_DIR}/calls"
    export FAKE_APPLIED="${CASE_DIR}/applied"
    export GITHUB_ENV="${CASE_DIR}/github-env"
    export RUNNER_TEMP="${CASE_DIR}/runner-temp"
    export RADIUS_TARGET_KUBECONFIG="${CASE_DIR}/target/kubeconfig"
    export AZURE_CLIENT_ID="${CLIENT_ID}"
    export AZURE_TENANT_ID="${TENANT_ID}"
    export FAKE_EXPECTED_SERVER_ID="${SERVER_ID}"
    mkdir -p "${FAKE_STATE}" "${RUNNER_TEMP}" "${CASE_DIR}/target"
    : >"${FAKE_CASE_CALLS}"
    : >"${FAKE_APPLIED}"
    : >"${GITHUB_ENV}"
    unset KUBECONFIG FAKE_OIDC_STATUS FAKE_ENTRA_STATUS FAKE_ENTRA_BODY \
        FAKE_KUBECTL_VIEW_FAILS FAKE_KUBECTL_APPLY_FAILS RADIUS_AKS_ANNOTATION RADIUS_AKS_SERVER_ID \
        RADIUS_AKS_CLIENT_ID RADIUS_AKS_TENANT_ID RADIUS_AKS_AUTHORITY \
        RADIUS_AKS_TOKEN_SCRIPT
}

# Runs a command and stores its combined output in OUTPUT and its exit code in
# STATUS.
run() {
    set +e
    OUTPUT="$("$@" 2>&1)"
    STATUS=$?
    set -e
}

calls_to() {
    grep -c "^$1 " "${FAKE_CASE_CALLS}" || true
}

# Output lines other than ::add-mask:: commands, which the runner hides.
visible_output() {
    grep -v '^::add-mask::' <<<"${OUTPUT}" || true
}

file_mode() {
    stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

# Checks for exactly one annotation, at the given level, whose message starts
# with the given text.
expect_one_annotation() {
    local level="$1" message="$2" name="$3" count
    count="$(grep -c '^::\(error\|warning\)' <<<"${OUTPUT}" || true)"
    [[ "${count}" == "1" ]] || fail "${name}: expected one annotation, got ${count}: ${OUTPUT}"
    grep '^::\(error\|warning\)::' <<<"${OUTPUT}" | grep -qF "::${level}::${message}" ||
        fail "${name}: expected '::${level}::${message}', got: ${OUTPUT}"
}

expect_no_secret_output() {
    local name="$1"
    if visible_output | grep -q "${FAKE_ASSERTION_PREFIX}\|${FAKE_TOKEN_PREFIX}\|${FAKE_REQUEST_TOKEN}\|AADSTS"; then
        fail "${name}: a token, assertion, or Entra response leaked to the output"
    fi
}

# Converts a kubelogin kubeconfig and exports the settings that --convert wrote
# to GITHUB_ENV, as later workflow steps see them.
converted_case() {
    new_case
    kubelogin_kubeconfig "${KUBELOGIN_ARGS}" >"${RADIUS_TARGET_KUBECONFIG}"
    run bash "${AKS_SCRIPT}" --convert
    [[ "${STATUS}" == "0" ]] || fail "conversion before the test: ${OUTPUT}"
    while IFS='=' read -r name value; do
        export "${name}=${value}"
    done <"${GITHUB_ENV}"
    : >"${FAKE_CASE_CALLS}"
}

# --- 1. A kubelogin kubeconfig becomes a token kubeconfig ---------------------

new_case
kubelogin_kubeconfig "${KUBELOGIN_ARGS}" >"${RADIUS_TARGET_KUBECONFIG}"
original="$(cat "${RADIUS_TARGET_KUBECONFIG}")"
run bash "${AKS_SCRIPT}" --convert
[[ "${STATUS}" == "0" ]] || fail "convert: exit ${STATUS}: ${OUTPUT}"
jq -e --arg file "${POD_TOKEN_FILE}" \
    '.users == [{name: "clusterUser", user: {token: "fixture-aks-token-1", tokenFile: $file}}]' \
    "${RADIUS_TARGET_KUBECONFIG}" >/dev/null || fail "convert: user is not a token user"
jq -e --argjson original "${original}" \
    '.clusters == $original.clusters and .contexts == $original.contexts and ."current-context" == $original."current-context"' \
    "${RADIUS_TARGET_KUBECONFIG}" >/dev/null || fail "convert: cluster or context changed"
[[ "$(file_mode "${RADIUS_TARGET_KUBECONFIG}")" == "600" ]] || fail "convert: kubeconfig is readable by others"
expected_env="RADIUS_AKS_SERVER_ID=${SERVER_ID}
RADIUS_AKS_CLIENT_ID=${CLIENT_ID}
RADIUS_AKS_TENANT_ID=${TENANT_ID}
RADIUS_AKS_AUTHORITY=${AUTHORITY}
RADIUS_AKS_TOKEN_SCRIPT=${AKS_SCRIPT}"
[[ "$(cat "${GITHUB_ENV}")" == "${expected_env}" ]] || fail "convert: unexpected GITHUB_ENV: $(cat "${GITHUB_ENV}")"
[[ "$(head -1 <<<"${OUTPUT}")" == "::add-mask::fixture-assertion-1" ]] || fail "convert: assertion not masked first"
grep -qx '::add-mask::fixture-aks-token-1' <<<"${OUTPUT}" || fail "convert: token not masked"
expect_no_secret_output convert
[[ "$(calls_to curl)" == "2" && "$(calls_to az)" == "1" ]] || fail "convert: expected one OIDC request, one token request, and one az call"
[[ -z "$(ls -A "${RUNNER_TEMP}")" ]] || fail "convert: temporary files remain"
[[ -z "$(find "${CASE_DIR}/target" -name '.radius-aks-kubeconfig.*')" ]] || fail "convert: staged kubeconfig remains"
pass "a kubelogin kubeconfig becomes a token kubeconfig with tokenFile"

# --- 2. A certificate kubeconfig stays unchanged ------------------------------

new_case
certificate_kubeconfig >"${RADIUS_TARGET_KUBECONFIG}"
cp "${RADIUS_TARGET_KUBECONFIG}" "${CASE_DIR}/before"
run bash "${AKS_SCRIPT}" --convert
[[ "${STATUS}" == "0" ]] || fail "certificate: exit ${STATUS}: ${OUTPUT}"
cmp -s "${CASE_DIR}/before" "${RADIUS_TARGET_KUBECONFIG}" || fail "certificate: kubeconfig changed"
[[ ! -s "${GITHUB_ENV}" ]] || fail "certificate: settings were exported"
[[ "$(calls_to curl)" == "0" && "$(calls_to az)" == "0" ]] || fail "certificate: requested a token"
pass "a certificate kubeconfig stays unchanged"

# --- 3. Only the target kubeconfig is read ------------------------------------

new_case
export KUBECONFIG="${CASE_DIR}/default-kubeconfig"
kubelogin_kubeconfig "${KUBELOGIN_ARGS}" >"${KUBECONFIG}"
certificate_kubeconfig >"${RADIUS_TARGET_KUBECONFIG}"
cp "${KUBECONFIG}" "${CASE_DIR}/default-before"
cp "${RADIUS_TARGET_KUBECONFIG}" "${CASE_DIR}/target-before"
run bash "${AKS_SCRIPT}" --convert
[[ "${STATUS}" == "0" ]] || fail "default kubeconfig: exit ${STATUS}: ${OUTPUT}"
cmp -s "${CASE_DIR}/target-before" "${RADIUS_TARGET_KUBECONFIG}" || fail "default kubeconfig: target changed"
cmp -s "${CASE_DIR}/default-before" "${KUBECONFIG}" || fail "default kubeconfig: default changed"
[[ "$(calls_to curl)" == "0" && ! -s "${GITHUB_ENV}" ]] || fail "default kubeconfig: converted the default kubeconfig"

new_case
export KUBECONFIG="${CASE_DIR}/default-kubeconfig"
certificate_kubeconfig >"${KUBECONFIG}"
cp "${KUBECONFIG}" "${CASE_DIR}/default-before"
kubelogin_kubeconfig "${KUBELOGIN_ARGS}" >"${RADIUS_TARGET_KUBECONFIG}"
run bash "${AKS_SCRIPT}" --convert
[[ "${STATUS}" == "0" ]] || fail "default kubeconfig: exit ${STATUS}: ${OUTPUT}"
cmp -s "${CASE_DIR}/default-before" "${KUBECONFIG}" || fail "default kubeconfig: default changed"
jq -e '.users[0].user.token == "fixture-aks-token-1"' "${RADIUS_TARGET_KUBECONFIG}" >/dev/null ||
    fail "default kubeconfig: target was not converted"
pass "a default kubeconfig that differs from the target stays unchanged"

# --- 4. The server ID comes from --server-id, or the documented default -------

for args in \
    '["get-token","--login","devicecode"]' \
    '["get-token","--server-id","","--login","devicecode"]' \
    "[\"get-token\",\"--server-id=${SERVER_ID}\",\"--login\",\"devicecode\"]"; do
    new_case
    expected="${DEFAULT_SERVER_ID}"
    if [[ "${args}" == *"--server-id="* ]]; then
        expected="${SERVER_ID}"
    fi
    export FAKE_EXPECTED_SERVER_ID="${expected}"
    kubelogin_kubeconfig "${args}" >"${RADIUS_TARGET_KUBECONFIG}"
    run bash "${AKS_SCRIPT}" --convert
    [[ "${STATUS}" == "0" ]] || fail "server ID ${args}: exit ${STATUS}: ${OUTPUT}"
    grep -qx "RADIUS_AKS_SERVER_ID=${expected}" "${GITHUB_ENV}" ||
        fail "server ID ${args}: exported the wrong server ID"
done
pass "an exec entry without --server-id uses the documented server application ID"

# --- 5. Failures stop with one annotation and no secrets ----------------------

expect_failure() {
    local name="$1" message="$2" level="${3:-error}"
    run bash "${AKS_SCRIPT}" --convert
    [[ "${STATUS}" == "1" ]] || fail "${name}: expected exit 1, got ${STATUS}: ${OUTPUT}"
    expect_one_annotation "${level}" "${message}" "${name}"
    expect_no_secret_output "${name}"
    cmp -s "${CASE_DIR}/before" "${RADIUS_TARGET_KUBECONFIG}" || fail "${name}: kubeconfig changed"
    [[ ! -s "${GITHUB_ENV}" ]] || fail "${name}: settings were exported"
    [[ -z "$(ls -A "${RUNNER_TEMP}")" ]] || fail "${name}: temporary files remain"
    pass "${name} stops with one ${level} annotation"
}

kubelogin_case() {
    new_case
    kubelogin_kubeconfig "${KUBELOGIN_ARGS}" >"${RADIUS_TARGET_KUBECONFIG}"
    cp "${RADIUS_TARGET_KUBECONFIG}" "${CASE_DIR}/before"
}

readonly ENTRA_FAILURE="Microsoft Entra did not return an AKS token for the deploy identity"
while IFS='|' read -r name status body detail; do
    kubelogin_case
    export FAKE_ENTRA_STATUS="${status}" FAKE_ENTRA_BODY="${body}"
    expect_failure "${name}" "${ENTRA_FAILURE} (HTTP ${detail})."
done <<'CASES'
Entra invalid_client|401|{"error":"invalid_client","error_description":"AADSTS700213: No matching federated identity record found."}|401, invalid_client
Entra 400 with an unusable error field|400|{"error":"Bad::Code\n::error::x"}|400, no error code
Entra outage|503|<html>AADSTS service unavailable</html>|503, no error code
Entra not reached|000||000, no error code
Entra success without a token|200|{"token_type":"Bearer","expires_in":3599}|200, no error code
CASES

kubelogin_case
export FAKE_ENTRA_STATUS=401 FAKE_ENTRA_BODY='{"error":"invalid_client"}'
export RADIUS_AKS_ANNOTATION=warning
expect_failure "a warning-level caller" "${ENTRA_FAILURE} (HTTP 401, invalid_client)." warning

kubelogin_case
export FAKE_OIDC_STATUS=500
expect_failure "a GitHub OIDC failure" "GitHub did not return an OIDC token for the AKS token request (HTTP 500)."

kubelogin_case
run env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN bash "${AKS_SCRIPT}" --convert
[[ "${STATUS}" == "1" && "$(calls_to curl)" == "0" ]] || fail "missing id-token permission: ${OUTPUT}"
expect_one_annotation error "This job cannot request a GitHub OIDC token." "missing id-token permission"
pass "a job without id-token: write stops with one error annotation"

new_case
kubelogin_kubeconfig '["get-token","--server-id","--login","devicecode"]' >"${RADIUS_TARGET_KUBECONFIG}"
cp "${RADIUS_TARGET_KUBECONFIG}" "${CASE_DIR}/before"
expect_failure "a flag in place of the server ID" "The kubelogin --server-id value in the AKS kubeconfig is not a valid application ID."

kubelogin_case
export AZURE_CLIENT_ID=""
expect_failure "an empty client ID" "AZURE_CLIENT_ID is empty or is not a valid Microsoft Entra ID."

kubelogin_case
export FAKE_KUBECTL_VIEW_FAILS=1
expect_failure "an unreadable kubeconfig" "kubectl could not read one user and one cluster"

new_case
: >"${CASE_DIR}/before"
export RADIUS_TARGET_KUBECONFIG="${CASE_DIR}/missing"
run bash "${AKS_SCRIPT}" --convert
[[ "${STATUS}" == "1" ]] || fail "missing kubeconfig: exit ${STATUS}"
expect_one_annotation error "No AKS kubeconfig exists at RADIUS_TARGET_KUBECONFIG." "missing kubeconfig"
pass "a missing kubeconfig stops with one error annotation"

# --- 6. The refresher renews the Secret and the runner file -------------------

converted_case
export AZURE_OIDC_REFRESH_INTERVAL_SECONDS=1

run bash "${REFRESH_SCRIPT}" --prepare
[[ "${STATUS}" == "0" ]] || fail "refresher prepare: exit ${STATUS}: ${OUTPUT}"
run bash "${REFRESH_SCRIPT}" --watch 2
[[ "${STATUS}" == "0" ]] || fail "refresher watch: exit ${STATUS}: ${OUTPUT}"
expect_no_secret_output refresher

secrets="$(grep -c '^secret target-kubeconfig$' "${FAKE_APPLIED}" || true)"
[[ "${secrets}" == "3" ]] || fail "refresher: expected three target-kubeconfig updates, got ${secrets}"
for token in 2 3 4; do
    grep -qx "token=fixture-aks-token-${token}" "${FAKE_APPLIED}" ||
        fail "refresher: the Secret's token key never held token ${token}"
    grep -q "\"token\": \"fixture-aks-token-${token}\"" "${FAKE_APPLIED}" ||
        fail "refresher: the Secret's kubeconfig never held token ${token}"
done
[[ "$(grep -c '^secret azure-oidc-token$' "${FAKE_APPLIED}")" == "3" ]] ||
    fail "refresher: expected three azure-oidc-token updates"
jq -e --arg file "${POD_TOKEN_FILE}" \
    '.users[0].user == {token: "fixture-aks-token-4", tokenFile: $file}' \
    "${RADIUS_TARGET_KUBECONFIG}" >/dev/null || fail "refresher: runner kubeconfig not renewed"
[[ "$(calls_to 'kubectl rollout restart')" == "3" ]] || fail "refresher: consumers not restarted once each"
[[ "$(cat "${FAKE_STATE}/entra-count")" == "4" ]] ||
    fail "refresher: expected one AKS token for conversion and one for each refresh"
pass "the refresher renews the AKS token in the Secret and the runner file"

cp "${RADIUS_TARGET_KUBECONFIG}" "${CASE_DIR}/before"
export FAKE_ENTRA_STATUS=503 FAKE_ENTRA_BODY='{"error":"temporarily_unavailable"}'
run bash "${REFRESH_SCRIPT}" --watch 1
[[ "${STATUS}" == "0" ]] || fail "refresher retry: exit ${STATUS}: ${OUTPUT}"
if grep -q '^::error' <<<"${OUTPUT}"; then
    fail "refresher retry: a retried failure was reported as an error: ${OUTPUT}"
fi
grep -qF "::warning::${ENTRA_FAILURE} (HTTP 503, temporarily_unavailable)." <<<"${OUTPUT}" ||
    fail "refresher retry: expected a warning: ${OUTPUT}"
cmp -s "${CASE_DIR}/before" "${RADIUS_TARGET_KUBECONFIG}" || fail "refresher retry: kubeconfig changed"
pass "a failed renewal while watching is a warning"

run bash "${REFRESH_SCRIPT}" --prepare
[[ "${STATUS}" != "0" ]] || fail "refresher prepare failure: expected a failed step"
expect_one_annotation error "${ENTRA_FAILURE}" "refresher prepare failure"
pass "a failed renewal before commands run fails with one error annotation"

new_case
unset RADIUS_AKS_SERVER_ID
run bash "${REFRESH_SCRIPT}" --prepare
[[ "${STATUS}" == "0" ]] || fail "refresher without AKS: ${OUTPUT}"
if grep -q '^secret target-kubeconfig$' "${FAKE_APPLIED}"; then
    fail "refresher without AKS: changed the target-kubeconfig Secret"
fi
pass "the refresher leaves target-kubeconfig alone without an AKS token"

converted_case
cp "${RADIUS_TARGET_KUBECONFIG}" "${CASE_DIR}/before"
export FAKE_KUBECTL_APPLY_FAILS=1
run bash "${AKS_SCRIPT}" --renew
[[ "${STATUS}" == "1" ]] || fail "Secret update failure: exit ${STATUS}"
expect_one_annotation error "Radius could not store the AKS token" "Secret update failure"
cmp -s "${CASE_DIR}/before" "${RADIUS_TARGET_KUBECONFIG}" ||
    fail "Secret update failure: the runner kubeconfig no longer matches the Secret"
[[ -z "$(find "${CASE_DIR}/target" -name '.radius-aks-kubeconfig.*')" ]] ||
    fail "Secret update failure: staged kubeconfig remains"
pass "a failed Secret update stops with one error annotation and keeps the runner kubeconfig"

# --- The workflows' "Refresh external deployment target credentials" step ----

readonly REFRESH_STEP="Refresh external deployment target credentials"

# Writes a step's run block to a script, as GitHub runs it with `bash -e`.
extract_run_block() {
    python3 - "$1" "$2" "$3" <<'PYTHON'
import re
import sys

workflow_file, step, out_file = sys.argv[1:4]
lines = open(workflow_file, encoding="utf-8").read().splitlines()
names = [
    i for i, line in enumerate(lines)
    if re.match(r"^\s*-\s+name:\s+" + re.escape(step) + r"\s*$", line)
]
if len(names) != 1:
    sys.exit("expected one '%s' step, found %d" % (step, len(names)))
indent = len(lines[names[0]]) - len(lines[names[0]].lstrip(" "))
run_at = next(
    i for i in range(names[0] + 1, len(lines))
    if lines[i].strip() == "run: |"
)
body = []
for line in lines[run_at + 1:]:
    if line.strip() and len(line) - len(line.lstrip(" ")) <= indent + 2:
        break
    body.append(line[indent + 4:])
script = "\n".join(body) + "\n"
if "${{" in script:
    sys.exit("expression left in step '%s'" % step)
open(out_file, "w", encoding="utf-8").write(script)
PYTHON
}

for workflow in run-rad-commands-azure.yml delete-azure.yml delete-environment-azure.yml; do
    step_script="${TEST_ROOT}/${workflow%.yml}-refresh.sh"
    extract_run_block "${SCRIPT_DIR}/../${workflow}" "${REFRESH_STEP}" "${step_script}" ||
        fail "${workflow}: could not extract the refresh step"

    converted_case
    run bash -e "${step_script}"
    [[ "${STATUS}" == "0" ]] || fail "${workflow} refresh step: exit ${STATUS}: ${OUTPUT}"
    expect_no_secret_output "${workflow} refresh step"
    [[ "$(grep -c '^secret target-kubeconfig$' "${FAKE_APPLIED}")" == "1" ]] ||
        fail "${workflow} refresh step: expected one Secret update"
    grep -qx 'token=fixture-aks-token-2' "${FAKE_APPLIED}" ||
        fail "${workflow} refresh step: the Secret's token key is not the renewed token"
    grep -q '"token": "fixture-aks-token-2"' "${FAKE_APPLIED}" ||
        fail "${workflow} refresh step: the Secret's kubeconfig is not the renewed token"
    jq -e --arg file "${POD_TOKEN_FILE}" \
        '.users[0].user == {token: "fixture-aks-token-2", tokenFile: $file}' \
        "${RADIUS_TARGET_KUBECONFIG}" >/dev/null ||
        fail "${workflow} refresh step: runner kubeconfig not renewed"
    [[ "$(calls_to 'kubectl rollout restart')" == "3" ]] ||
        fail "${workflow} refresh step: consumers not restarted"
    [[ -z "$(ls -A "${RUNNER_TEMP}")" ]] || fail "${workflow} refresh step: temporary files remain"

    new_case
    certificate_kubeconfig >"${RADIUS_TARGET_KUBECONFIG}"
    cp "${RADIUS_TARGET_KUBECONFIG}" "${CASE_DIR}/before"
    run bash -e "${step_script}"
    [[ "${STATUS}" == "0" ]] || fail "${workflow} certificate refresh: exit ${STATUS}: ${OUTPUT}"
    cmp -s "${CASE_DIR}/before" "${RADIUS_TARGET_KUBECONFIG}" ||
        fail "${workflow} certificate refresh: kubeconfig changed"
    grep -q '"certificate-cluster-token"' "${FAKE_APPLIED}" ||
        fail "${workflow} certificate refresh: the Secret lacks the kubeconfig"
    if grep -q '^token=' "${FAKE_APPLIED}"; then
        fail "${workflow} certificate refresh: the Secret gained a token key"
    fi
    [[ "$(calls_to curl)" == "0" ]] || fail "${workflow} certificate refresh: requested a token"

    converted_case
    cp "${RADIUS_TARGET_KUBECONFIG}" "${CASE_DIR}/before"
    export FAKE_ENTRA_STATUS=503
    run bash -e "${step_script}"
    [[ "${STATUS}" != "0" ]] || fail "${workflow} failed renewal: the step succeeded"
    expect_one_annotation error "${ENTRA_FAILURE}" "${workflow} failed renewal"
    [[ ! -s "${FAKE_APPLIED}" && "$(calls_to 'kubectl rollout')" == "0" ]] ||
        fail "${workflow} failed renewal: changed the Secret or restarted consumers"
    cmp -s "${CASE_DIR}/before" "${RADIUS_TARGET_KUBECONFIG}" ||
        fail "${workflow} failed renewal: kubeconfig changed"
    pass "${workflow} refreshes the Secret with a renewed AKS token, keeps a certificate kubeconfig, and stops on a failed renewal"
done

# --- 7. No fake received a secret on its command line -------------------------

[[ ! -s "${FAKE_REJECTS}" ]] || fail "fakes rejected calls: $(cat "${FAKE_REJECTS}")"
if grep -q "${FAKE_ASSERTION_PREFIX}\|${FAKE_TOKEN_PREFIX}\|${FAKE_REQUEST_TOKEN}" "${FAKE_CALLS}"; then
    fail "a token, assertion, or request token appeared on a command line"
fi
[[ "$(grep -c '^curl ' "${FAKE_CALLS}")" -gt 0 ]] || fail "no calls were recorded"
pass "no token, assertion, or request token appears on a command line"

echo "azure-aks-token tests passed"
