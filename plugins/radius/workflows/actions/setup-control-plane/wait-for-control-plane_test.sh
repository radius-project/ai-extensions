#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

mkdir -p "${TEST_ROOT}/bin" "${TEST_ROOT}/tmp"
export TEST_ROOT
export TMPDIR="${TEST_ROOT}/tmp"
export GITHUB_ACTION_PATH="${SCRIPT_DIR}"
export GITHUB_WORKSPACE_SAFE="${TEST_ROOT}/workspace with spaces"

python3 - "${SCRIPT_DIR}/action.yml" >"${TEST_ROOT}/action.sh" <<'PY'
import pathlib
import sys
import textwrap

source = pathlib.Path(sys.argv[1]).read_text()
step = source.split("    - name: Create ephemeral Radius control plane cluster\n", 1)[1]
step = step.split("\n    - name:", 1)[0]
print("#!/usr/bin/env bash")
print("set -euo pipefail")
print(textwrap.dedent(step.split("      run: |\n", 1)[1]))
PY
shellcheck "${TEST_ROOT}/action.sh"

cat >"${TEST_ROOT}/bin/k3d" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 10 && "$1 $2 $3" == "cluster create radius-cp" &&
    "$4" == "--volume" && "$5" == "/var/run/docker.sock:/var/run/docker.sock" &&
    "$6" == "--volume" && "$7" == "${GITHUB_WORKSPACE_SAFE}/:/app/demo" &&
    "$8" == "--k3s-arg" && "$9" == "--disable=traefik@server:*" &&
    "${10}" == "--wait" ]] || exit 98
printf '%s\n' "create" >>"${TEST_ROOT}/k3d.log"
[[ "${SCENARIO}" != create-failed ]] || exit 7
BASH
cat >"${TEST_ROOT}/bin/kubectl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "wait --for=condition=Ready node --all --timeout=120s" ]] || exit 98
printf '%s\n' "$*" >>"${TEST_ROOT}/kubectl.log"
count="$(wc -l <"${TEST_ROOT}/kubectl.log")"
case "${SCENARIO}" in
    success) ;;
    recover-*)
        failures="${SCENARIO#recover-}"
        if ((count <= failures)); then
            echo 'E1124 memcache.go:381] "Could not get API groups" err="the server is currently unable to handle the request"' >&2
            echo 'Error from server (ServiceUnavailable): the server is currently unable to handle the request' >&2
            exit 1
        fi
        ;;
    exhausted)
        echo 'Error from server (ServiceUnavailable): the server is currently unable to handle the request' >&2
        exit 1
        ;;
    forbidden)
        echo 'Error from server (Forbidden): nodes is forbidden' >&2
        exit 1
        ;;
    readiness-timeout)
        echo 'error: timed out waiting for the condition on nodes/k3d-radius-cp-server-0' >&2
        exit 1
        ;;
    misleading)
        echo 'Error from server (Forbidden): ServiceUnavailable is not permission to retry' >&2
        exit 1
        ;;
    interrupted)
        echo 'Error from server (ServiceUnavailable): the server is currently unable to handle the request' >&2
        exit 124
        ;;
    deadline) exec /usr/bin/sleep 10 ;;
    *) exit 98 ;;
esac
echo 'node/k3d-radius-cp-server-0 condition met'
BASH
cat >"${TEST_ROOT}/bin/sleep" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_ROOT}/sleep.log"
BASH
cat >"${TEST_ROOT}/bin/timeout" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 3 && "$1" == 120s && "$2" == bash &&
    "$3" == "${GITHUB_ACTION_PATH}/wait-for-control-plane.sh" ]] || exit 98
printf '%s\n' "120s" >>"${TEST_ROOT}/timeout.log"
if [[ "${SCENARIO}" == deadline ]]; then
    exec /usr/bin/timeout 0.1s "$2" "$3"
fi
exec /usr/bin/timeout "$@"
BASH
chmod +x "${TEST_ROOT}/bin/"*
export PATH="${TEST_ROOT}/bin:${PATH}"

run_case() {
    export SCENARIO="$1"
    : >"${TEST_ROOT}/k3d.log"
    : >"${TEST_ROOT}/kubectl.log"
    : >"${TEST_ROOT}/sleep.log"
    : >"${TEST_ROOT}/timeout.log"
    result=0
    bash "${TEST_ROOT}/action.sh" >"${TEST_ROOT}/output" 2>&1 || result=$?
    [[ "$result" -eq "$2" ]] || fail "$1 returned $result instead of $2"
    [[ "$(wc -l <"${TEST_ROOT}/kubectl.log")" -eq "$3" ]] ||
        fail "$1 made the wrong number of readiness reads"
    [[ "$(paste -sd, "${TEST_ROOT}/sleep.log")" == "$4" ]] ||
        fail "$1 used the wrong retry delays"
    [[ -z "$(find "${TMPDIR}" -type f -print -quit)" ]] ||
        fail "$1 left temporary output behind"
}

run_case success 0 1 ""
grep -Fxq 'node/k3d-radius-cp-server-0 condition met' "${TEST_ROOT}/output" ||
    fail "success lost the readiness result"
for failures in 1 2 3 4; do
    delays=(1 2 4 8)
    expected="$(IFS=,; echo "${delays[*]:0:failures}")"
    run_case "recover-${failures}" 0 "$((failures + 1))" "$expected"
    grep -Fq 'Error from server (ServiceUnavailable)' "${TEST_ROOT}/output" ||
        fail "recovery hid the API error"
done
grep -Fxq 120s "${TEST_ROOT}/timeout.log" ||
    fail "the action did not cap the whole readiness check at 120 seconds"
run_case exhausted 1 5 "1,2,4,8"
grep -Fq 'Error from server (ServiceUnavailable)' "${TEST_ROOT}/output" ||
    fail "exhaustion lost the original API error"
for scenario in forbidden readiness-timeout misleading; do
    run_case "$scenario" 1 1 ""
done
run_case interrupted 124 1 ""
run_case deadline 124 1 ""
run_case create-failed 7 0 ""
[[ ! -s "${TEST_ROOT}/timeout.log" ]] ||
    fail "failed cluster creation reached the readiness helper"

echo "Control-plane readiness tests passed (12 cases)"
