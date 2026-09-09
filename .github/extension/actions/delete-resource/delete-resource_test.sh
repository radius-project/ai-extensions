#!/bin/bash

# Behavioral tests for the delete-resource composite action's `rad` command
# contract and its single-resource ownership guard.
#
# The action's `run:` block is extracted from the composite action YAML and
# executed with a stubbed `rad` on PATH, so the exact argv the action would
# issue is observable without a cluster or the real CLI.
#
# Invariants covered:
#   1. An application delete runs `rad app delete <name> --yes --preview`.
#   2. An environment delete runs `rad env delete <name> --yes --preview`.
#   3. A single-resource delete runs `rad resource delete <type> <name> --yes`
#      and NEVER passes `--preview` or `--application`: neither flag exists on
#      that command, so passing either aborts the run instead of deleting.
#   4. A single-resource delete verifies ownership with `rad resource show`
#      BEFORE deleting, and refuses when the resource belongs to another
#      application or another environment.
#   5. A single-resource delete refuses when ownership cannot be read at all.
#   6. Incomplete or unsupported input fails closed without touching the
#      control plane.
#   7. The rad-delete-result artifact is always written, and carries the
#      outcome, exit code and full target identity.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
readonly REPO_ROOT

if ! command -v python3 >/dev/null 2>&1; then
    echo "FAIL: python3 is required to parse action.yml" >&2
    exit 1
fi

python3 - "${REPO_ROOT}" <<'PYTHON'
import collections
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

repo_root = pathlib.Path(sys.argv[1])
ext_root = repo_root / ".github/extension"
action_file = ext_root / "actions/delete-resource/action.yml"

failures = []
scratch_root = pathlib.Path(tempfile.mkdtemp(prefix="delete-resource-test-"))


def fail(message):
    failures.append(message)


def extract_run_block(path, step_name):
    lines = path.read_text(encoding="utf-8").splitlines()
    name_pattern = re.compile(r"^\s*-\s*name:\s*" + re.escape(step_name) + r"\s*$")
    name_idx = next((i for i, line in enumerate(lines) if name_pattern.match(line)), None)
    if name_idx is None:
        sys.exit(f"{path}: step '{step_name}' not found")
    run_pattern = re.compile(r"^\s*run:\s*\|\s*$")
    run_idx = next(
        (i for i in range(name_idx + 1, len(lines)) if run_pattern.match(lines[i])), None
    )
    if run_idx is None:
        sys.exit(f"{path}: step '{step_name}' has no 'run: |' block")
    body, base_indent = [], None
    for line in lines[run_idx + 1:]:
        if not line.strip():
            body.append("")
            continue
        indent = len(line) - len(line.lstrip(" "))
        if base_indent is None:
            base_indent = indent
        if indent < base_indent:
            break
        body.append(line[base_indent:])
    if not any(chunk.strip() for chunk in body):
        sys.exit(f"{path}: step '{step_name}' run block is empty")
    return "\n".join(body).rstrip("\n") + "\n"


_case_counter = [0]

RunResult = collections.namedtuple("RunResult", "code stdout stderr rad result")


def run_block(
    script,
    env_extra=None,
    show_payload=None,
    show_exit=0,
    delete_exit=0,
    expect_failure=False,
):
    """Execute the delete block with a stubbed `rad`.

    show_payload: JSON text the `rad resource show` stub prints on stdout.
    show_exit / delete_exit: exit codes for the show and delete verbs.
    Returns the process result, the recorded rad argv lines and the parsed
    rad-delete-result artifact (or None when it was never written).
    """
    _case_counter[0] += 1
    workdir = scratch_root / f"case-{_case_counter[0]}"
    bin_dir = workdir / "bin"
    bin_dir.mkdir(parents=True)
    rad_log = workdir / "rad.log"
    show_file = workdir / "show.json"
    show_file.write_text(show_payload or "{}", encoding="utf-8")
    result_dir = workdir / "radius-output"
    result_dir.mkdir()

    (bin_dir / "rad").write_text(
        "#!/bin/bash\n"
        'printf \'%s\\n\' "$*" >> "${RAD_LOG}"\n'
        'if [ "$1" = "resource" ] && [ "$2" = "show" ]; then\n'
        '  cat "${SHOW_FILE}"\n'
        '  exit "${SHOW_EXIT}"\n'
        "fi\n"
        'exit "${DELETE_EXIT}"\n',
        encoding="utf-8",
    )
    (bin_dir / "rad").chmod(0o755)

    # The action writes to a fixed /tmp path; redirect it into the case dir so
    # concurrent cases cannot see each other's artifact.
    script = script.replace("/tmp/radius-output", str(result_dir))
    script_path = workdir / "block.sh"
    script_path.write_text(script, encoding="utf-8")

    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["RAD_LOG"] = str(rad_log)
    env["SHOW_FILE"] = str(show_file)
    env["SHOW_EXIT"] = str(show_exit)
    env["DELETE_EXIT"] = str(delete_exit)
    env.setdefault("RESOURCE_TYPE", "application")
    env.setdefault("RESOURCE_NAME", "todolist")
    env.setdefault("APPLICATION", "")
    env.setdefault("ENVIRONMENT", "")
    env.setdefault("RADIUS_RESOURCE_TYPE", "")
    env["REFRESH_AZURE_OIDC_TOKEN"] = "false"
    if env_extra:
        env.update(env_extra)

    proc = subprocess.run(
        ["bash", "-eo", "pipefail", str(script_path)],
        capture_output=True,
        text=True,
        env=env,
    )
    if expect_failure and proc.returncode == 0:
        fail("expected the delete block to fail but it exited 0")
    if not expect_failure and proc.returncode != 0:
        fail(
            f"delete block exited {proc.returncode}: "
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    invocations = rad_log.read_text(encoding="utf-8") if rad_log.exists() else ""
    artifact = result_dir / "rad-delete-result.json"
    parsed = json.loads(artifact.read_text(encoding="utf-8")) if artifact.exists() else None
    return RunResult(proc.returncode, proc.stdout, proc.stderr, invocations, parsed)


def rad_calls(result):
    return [line for line in result.rad.splitlines() if line.strip()]


def owned_by(application="todolist", environment="dev"):
    scope = "/planes/radius/local/resourceGroups/default/providers"
    properties = {}
    if application:
        properties["application"] = f"{scope}/Radius.Core/applications/{application}"
    if environment:
        properties["environment"] = f"{scope}/Radius.Core/environments/{environment}"
    return json.dumps({"name": "cache", "properties": properties})


block = extract_run_block(action_file, "Delete Radius resource")

RESOURCE_ENV = {
    "RESOURCE_TYPE": "resource",
    "RESOURCE_NAME": "cache",
    "APPLICATION": "todolist",
    "ENVIRONMENT": "dev",
    "RADIUS_RESOURCE_TYPE": "Radius.Data/redisCaches",
}

# 1. Application delete: exact argv, preview-wired.
app = run_block(block, env_extra={"RESOURCE_TYPE": "application", "RESOURCE_NAME": "todolist"})
if rad_calls(app) != ["app delete todolist --yes --preview"]:
    fail(f"application delete argv drifted: {rad_calls(app)}")
if app.result != {
    "schemaVersion": "1.0",
    "outcome": "succeeded",
    "exitCode": 0,
    "resourceType": "application",
    "name": "todolist",
    "application": "",
    "environment": "",
    "radiusResourceType": "",
    "output": "",
}:
    fail(f"application delete result artifact drifted: {app.result}")

# 2. Environment delete: exact argv, preview-wired.
env_delete = run_block(block, env_extra={"RESOURCE_TYPE": "environment", "RESOURCE_NAME": "dev"})
if rad_calls(env_delete) != ["env delete dev --yes --preview"]:
    fail(f"environment delete argv drifted: {rad_calls(env_delete)}")

# 3. Single-resource delete: show-then-delete, with the supported flag set only.
resource = run_block(block, env_extra=RESOURCE_ENV, show_payload=owned_by())
calls = rad_calls(resource)
if calls != [
    "resource show Radius.Data/redisCaches cache -o json",
    "resource delete Radius.Data/redisCaches cache --yes",
]:
    fail(f"single-resource delete argv drifted: {calls}")
for unsupported in ("--preview", "--application"):
    if unsupported in resource.rad:
        fail(
            f"`rad resource delete` must not pass {unsupported}: the command has no such flag"
        )
if resource.result != {
    "schemaVersion": "1.0",
    "outcome": "succeeded",
    "exitCode": 0,
    "resourceType": "resource",
    "name": "cache",
    "application": "todolist",
    "environment": "dev",
    "radiusResourceType": "Radius.Data/redisCaches",
    "output": "",
}:
    fail(f"single-resource result artifact drifted: {resource.result}")

# 4a. Ownership mismatch on the application: refuse, and never call delete.
wrong_app = run_block(
    block,
    env_extra=RESOURCE_ENV,
    show_payload=owned_by(application="other-app"),
    expect_failure=True,
)
if any(call.startswith("resource delete") for call in rad_calls(wrong_app)):
    fail("a resource owned by another application must never reach `rad resource delete`")
if wrong_app.result is None or wrong_app.result.get("outcome") != "ownership_mismatch":
    fail(f"an application-ownership mismatch must be reported: {wrong_app.result}")
if "other-app" not in wrong_app.stderr:
    fail("the refusal must name the application that actually owns the resource")

# 4b. Ownership mismatch on the environment: refuse, and never call delete.
wrong_env = run_block(
    block,
    env_extra=RESOURCE_ENV,
    show_payload=owned_by(environment="prod"),
    expect_failure=True,
)
if any(call.startswith("resource delete") for call in rad_calls(wrong_env)):
    fail("a resource owned by another environment must never reach `rad resource delete`")
if wrong_env.result is None or wrong_env.result.get("outcome") != "ownership_mismatch":
    fail(f"an environment-ownership mismatch must be reported: {wrong_env.result}")

# 4c. A resource that reports no owning application at all is refused: ownership
#     must be positively established, not merely "not contradicted".
no_owner = run_block(
    block,
    env_extra=RESOURCE_ENV,
    show_payload=owned_by(application="", environment="dev"),
    expect_failure=True,
)
if any(call.startswith("resource delete") for call in rad_calls(no_owner)):
    fail("a resource with no owning application must never be deleted")

# 4d. A resource that reports no environment is still deletable: core resources
#     commonly carry only an application, which the app itself binds to an env.
no_env = run_block(
    block, env_extra=RESOURCE_ENV, show_payload=owned_by(environment="")
)
if not any(call.startswith("resource delete") for call in rad_calls(no_env)):
    fail("a resource whose environment is implied by its application must still delete")

# 5. Ownership unreadable: refuse rather than deleting blind.
unreadable = run_block(
    block, env_extra=RESOURCE_ENV, show_exit=1, expect_failure=True
)
if any(call.startswith("resource delete") for call in rad_calls(unreadable)):
    fail("an unreadable resource must never reach `rad resource delete`")
if unreadable.result is None or unreadable.result.get("outcome") != "ownership_unverified":
    fail(f"an unreadable resource must report ownership_unverified: {unreadable.result}")

# 6. Fail-closed input validation, with no control-plane call at all.
for label, extra in (
    ("missing radius type", {**RESOURCE_ENV, "RADIUS_RESOURCE_TYPE": "   "}),
    ("missing application", {**RESOURCE_ENV, "APPLICATION": ""}),
    ("blank name", {**RESOURCE_ENV, "RESOURCE_NAME": "   "}),
    ("unsupported type", {"RESOURCE_TYPE": "cluster", "RESOURCE_NAME": "x"}),
):
    refused = run_block(block, env_extra=extra, expect_failure=True)
    if rad_calls(refused):
        fail(f"{label}: must not invoke rad at all, got {rad_calls(refused)}")
    if refused.code != 2:
        fail(f"{label}: must exit 2, got {refused.code}")
    if refused.result is None or refused.result.get("outcome") != "invalid_input":
        fail(f"{label}: must report invalid_input, got {refused.result}")

# 7. A failing delete still writes the artifact with the rad exit code.
failed = run_block(
    block, env_extra=RESOURCE_ENV, show_payload=owned_by(), delete_exit=7,
    expect_failure=True,
)
if failed.result is None or failed.result.get("outcome") != "failed":
    fail(f"a failed delete must be reported as failed: {failed.result}")
if failed.result.get("exitCode") != 7:
    fail(f"a failed delete must carry rad's exit code: {failed.result}")

# 8. Every workflow that passes resource_type=resource must also pass both the
#    owning application and the fully-qualified Radius type, or the guard above
#    can never run.
for workflow in sorted(ext_root.glob("*.yml")):
    text = workflow.read_text(encoding="utf-8")
    if "resource_type: resource" not in text:
        continue
    for required in ("application:", "radius_resource_type:"):
        if required not in text:
            fail(f"{workflow.name}: a resource delete must pass `{required}`")

# 9. The provider workflows must forward the ownership inputs to the action.
for provider in ("delete-azure.yml", "delete-aws.yml"):
    text = (ext_root / provider).read_text(encoding="utf-8")
    for required in (
        "application: ${{ inputs.application }}",
        "environment: ${{ inputs.environment }}",
        "radius-resource-type: ${{ inputs.radius_resource_type }}",
    ):
        if required not in text:
            fail(f"{provider}: must forward `{required}` to the delete-resource action")

shutil.rmtree(scratch_root, ignore_errors=True)

if failures:
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    sys.exit(1)

print("delete-resource action tests passed")
PYTHON
