#!/bin/bash

# Behavioral tests for the Radius install steps of the setup-control-plane
# action. The real `run:` blocks are extracted from action.yml and executed with
# stubbed curl, rad, and kubectl on PATH, so no network or cluster is needed.
#
# Invariants covered:
#   1. The CLI step runs install.sh with the pinned RADIUS_INSTALL_REF, never edge.
#   2. The CLI step fails when the installed CLI is not the pinned release.
#   3. The control-plane step accepts a control plane on the CLI's release
#      (including a newer patch) and fails for edge, prereleases, or any other
#      release.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly ACTION_FILE="${SCRIPT_DIR}/action.yml"
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
trap 'rm -rf "${TEST_ROOT}"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

for tool in python3 jq sha256sum; do
    command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required"
done

# Print the `run: |` body of the named step, dedented.
extract_run() {
    python3 - "${ACTION_FILE}" "$1" <<'PYTHON'
import re
import sys

lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
name = re.compile(r"^\s*-\s*name:\s*" + re.escape(sys.argv[2]) + r"\s*$")
start = next((i for i, line in enumerate(lines) if name.match(line)), None)
if start is None:
    sys.exit(f"step '{sys.argv[2]}' not found")
run = next(i for i in range(start + 1, len(lines)) if re.match(r"^\s*run:\s*\|\s*$", lines[i]))
body, indent = [], None
for line in lines[run + 1:]:
    if not line.strip():
        body.append("")
        continue
    width = len(line) - len(line.lstrip(" "))
    indent = width if indent is None else indent
    if width < indent:
        break
    body.append(line[indent:])
print("\n".join(body))
PYTHON
}

PINNED_REF="$(sed -nE 's/^[[:space:]]+RADIUS_INSTALL_REF: ([^[:space:]]+)$/\1/p' "${ACTION_FILE}")"
readonly PINNED_REF
[[ "${PINNED_REF}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail "RADIUS_INSTALL_REF is not a stable release tag: ${PINNED_REF}"
readonly PINNED_RELEASE="${PINNED_REF#v}"
readonly MINOR="${PINNED_RELEASE%.*}"

extract_run "Install Radius CLI" >"${TEST_ROOT}/install-cli.sh"
extract_run "Install Radius on control plane" >"${TEST_ROOT}/install-control-plane.sh"

mkdir -p "${TEST_ROOT}/bin" "${TEST_ROOT}/work"

# The fake install.sh only records the arguments it was given.
cat >"${TEST_ROOT}/install.sh" <<'BASH'
printf '%s\n' "$*" >"${INSTALL_ARGS_LOG}"
BASH
INSTALLER_SHA256="$(sha256sum "${TEST_ROOT}/install.sh" | awk '{print $1}')"
readonly INSTALLER_SHA256

cat >"${TEST_ROOT}/bin/curl" <<'BASH'
#!/bin/bash
set -euo pipefail
output=""
while (($#)); do
    if [[ "$1" == "-o" ]]; then
        output="$2"
        shift 2
    else
        shift
    fi
done
cp "${FAKE_INSTALLER}" "${output}"
BASH

cat >"${TEST_ROOT}/bin/rad" <<'BASH'
#!/bin/bash
set -euo pipefail
case "$*" in
    "version --cli -o json")
        printf '{"release":"%s","version":"%s"}\n' "${FAKE_CLI_RELEASE}" "${FAKE_CLI_VERSION}"
        ;;
    "version -o json")
        printf '{"cli":{"release":"%s","version":"%s"},"controlPlane":{"version":"%s","status":"Installed"}}\n' \
            "${FAKE_CLI_RELEASE}" "${FAKE_CLI_VERSION}" "${FAKE_CONTROL_PLANE_VERSION}"
        ;;
    version | "install kubernetes"*) ;;
    *)
        echo "unexpected rad $*" >&2
        exit 1
        ;;
esac
BASH

printf '#!/bin/bash\n' >"${TEST_ROOT}/bin/kubectl"
chmod +x "${TEST_ROOT}/bin/curl" "${TEST_ROOT}/bin/rad" "${TEST_ROOT}/bin/kubectl"

# run_step <script> <cli release> <control plane version>
run_step() {
    local release="$2"
    local version="v${release}"
    [[ "${release}" != edge ]] || version=edge
    (
        cd "${TEST_ROOT}/work"
        PATH="${TEST_ROOT}/bin:${PATH}" \
            FAKE_INSTALLER="${TEST_ROOT}/install.sh" \
            INSTALL_ARGS_LOG="${TEST_ROOT}/install-args.log" \
            FAKE_CLI_RELEASE="${release}" \
            FAKE_CLI_VERSION="${version}" \
            FAKE_CONTROL_PLANE_VERSION="$3" \
            RADIUS_INSTALL_REF="${PINNED_REF}" \
            RADIUS_INSTALL_SHA256="${INSTALLER_SHA256}" \
            RADIUS_TARGET_KUBECONFIG="" \
            bash -euo pipefail "$1"
    ) >"${TEST_ROOT}/step.log" 2>&1
}

run_step "${TEST_ROOT}/install-cli.sh" "${PINNED_RELEASE}" "Not installed" ||
    fail "CLI step failed for the pinned release: $(cat "${TEST_ROOT}/step.log")"
[[ "$(cat "${TEST_ROOT}/install-args.log")" == "--version ${PINNED_REF}" ]] ||
    fail "install.sh was not asked for ${PINNED_REF}: $(cat "${TEST_ROOT}/install-args.log")"

for release in edge "${MINOR}.999"; do
    if run_step "${TEST_ROOT}/install-cli.sh" "${release}" "Not installed"; then
        fail "CLI step accepted CLI ${release} for pin ${PINNED_REF}"
    fi
    grep -Fq "::error::Installed Radius CLI" "${TEST_ROOT}/step.log" ||
        fail "CLI step did not explain the ${release} mismatch"
done

for control_plane in "${PINNED_RELEASE}" "${MINOR}.999"; do
    run_step "${TEST_ROOT}/install-control-plane.sh" "${PINNED_RELEASE}" "${control_plane}" ||
        fail "control-plane step rejected ${control_plane}: $(cat "${TEST_ROOT}/step.log")"
done

for control_plane in edge "Not installed" "" "${MINOR}" "${MINOR}." "${MINOR}0.0" "9${PINNED_RELEASE}" "999.0.0" \
    "${MINOR}.edge" "${MINOR}.1-rc.1" "${MINOR}.1-rc1" "${PINNED_RELEASE}.1" "v${PINNED_RELEASE}"; do
    if run_step "${TEST_ROOT}/install-control-plane.sh" "${PINNED_RELEASE}" "${control_plane}"; then
        fail "control-plane step accepted '${control_plane}' for CLI ${PINNED_RELEASE}"
    fi
    grep -Fq "::error::Installed Radius control plane" "${TEST_ROOT}/step.log" ||
        fail "control-plane step did not explain the '${control_plane}' mismatch"
done

echo "setup-control-plane install tests passed"
