#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
export ROOT
RADIUS_TEST_BASH="$BASH"
if command -v cygpath >/dev/null 2>&1; then RADIUS_TEST_BASH="$(cygpath -w "$BASH")"; fi
export RADIUS_TEST_BASH
python3 - <<'PY'
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

root = pathlib.Path(os.environ["ROOT"])
artifacts = root / ".artifacts"
artifacts.mkdir(exist_ok=True)
scratch = pathlib.Path(tempfile.mkdtemp(prefix="evidence-test-", dir=artifacts))
helper = root / ".github/extension/actions/lifecycle-evidence/evidence.sh"
actions = root / ".github/extension/actions"

def block(action, step):
    lines = (actions / action / "action.yml").read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == "- name: " + step)
    run = next(i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("run:"))
    if lines[run].strip() != "run: |":
        return lines[run].split("run: ", 1)[1]
    result = []
    for line in lines[run + 1:]:
        if line.strip() and not line.startswith("        "):
            break
        result.append(line[8:])
    return "\n".join(result)

def execute(script, env):
    return subprocess.run([os.environ["RADIUS_TEST_BASH"], "-eo", "pipefail", "-c", script], cwd=scratch,
                          env=env, text=True, capture_output=True)

try:
    bindir = scratch / "bin"
    bindir.mkdir()
    for name, text in {
        "git": 'if [ "$1" = rev-parse ]; then printf "%s\\n" "$ACTUAL_COMMIT"; fi\n',
        "rad": 'printf "%s\\n" "$*" >> "$CALLS"\ncase "$1" in startup) exit "$RESTORE_EXIT";; shutdown) exit "$SAVE_EXIT";; deploy) exit "$COMMAND_EXIT";; esac\n',
        "k3d": 'printf "cleanup\\n" >> "$CALLS"\nexit "$CLEANUP_EXIT"\n'
    }.items():
        path = bindir / name
        path.write_text("#!/usr/bin/env bash\n" + text, encoding="utf-8", newline="\n")
        path.chmod(0o755)
    env = {
        "PATH": str(bindir) + os.pathsep + os.environ["PATH"],
        "GITHUB_WORKSPACE": str(scratch), "GITHUB_ENV": str(scratch / "env"),
        "GITHUB_OUTPUT": str(scratch / "output"), "CALLS": str(scratch / "calls"),
        "GITHUB_REPOSITORY": "owner/repo", "ENVIRONMENT": "dev",
        "LIFECYCLE_APPLICATION": "app", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
        "LIFECYCLE_VERSION": "1", "LIFECYCLE_OPERATION": "deployment.start",
        "OPERATION_ID": "operation-1", "ATTEMPT_ID": "attempt-1",
        "EXPECTED_COMMIT": "a" * 40, "ACTUAL_COMMIT": "a" * 40,
        "RADIUS_LIFECYCLE_HELPER": helper.as_posix(),
        "RESTORE_EXIT": "0", "COMMAND_EXIT": "0", "SAVE_EXIT": "0", "CLEANUP_EXIT": "0"
    }
    prefix = 'source "$RADIUS_LIFECYCLE_HELPER"; '
    fields = ["LIFECYCLE_VERSION", "LIFECYCLE_OPERATION", "OPERATION_ID", "ATTEMPT_ID", "EXPECTED_COMMIT"]
    legacy = {key: value for key, value in env.items() if key not in fields}
    legacy_result = execute(prefix + "lifecycle_validate_inputs", legacy)
    assert legacy_result.returncode == 0, (legacy_result.returncode, legacy_result.stdout, legacy_result.stderr)
    for field in fields:
        partial = dict(env)
        del partial[field]
        assert execute(prefix + "lifecycle_validate_inputs", partial).returncode != 0, field
    for field, value in [
        ("EXPECTED_COMMIT", "branch"), ("LIFECYCLE_VERSION", "2"),
        ("LIFECYCLE_OPERATION", "environment.create"), ("OPERATION_ID", "unsafe\nid"),
        ("GITHUB_RUN_ATTEMPT", "0"), ("RAD_COMMANDS", "delete everything"),
        ("LIFECYCLE_APPLICATION", "../escape"), ("GITHUB_REPOSITORY", "bad")
    ]:
        assert execute(prefix + "lifecycle_validate_inputs", {**env, field: value}).returncode != 0
    assert execute(prefix + "lifecycle_initialize", {**env, "ACTUAL_COMMIT": "b" * 40}).returncode == 3
    command_body = block("run-rad-commands", "Run rad commands")
    command_prologue = command_body[command_body.index("RESULT_FILE="):
                                    command_body.index("trap cleanup EXIT") + len("trap cleanup EXIT")]
    command_prologue = command_prologue.replace("/tmp/radius-output", '"${RADIUS_TEST_OUTPUT_DIR}"')
    interrupted = {**env, "ATTEMPT_ID": "attempt-interrupted",
                   "RUNNER_TEMP": str(scratch),
                   "RADIUS_TEST_OUTPUT_DIR": (scratch / "command-output").as_posix(),
                   "RADIUS_TEST_PROGRESS_LIB": (actions / "deploy-progress/progress.sh").as_posix()}
    assert execute(prefix + "lifecycle_initialize", interrupted).returncode == 0
    interrupted["RADIUS_LIFECYCLE_FILE"] = str(scratch / ".radius-lifecycle-operation-1-attempt-interrupted/lifecycle-result.json")
    crashed = execute(prefix + 'source "$RADIUS_TEST_PROGRESS_LIB";\n' + command_prologue + "\nfalse\n", interrupted)
    assert crashed.returncode != 0
    interrupted_result = json.loads(pathlib.Path(interrupted["RADIUS_LIFECYCLE_FILE"]).read_text())
    assert interrupted_result["phases"]["commands"]["outcome"] == "unknown", crashed.stderr
    startup = block("restore-state", "Restore Radius state (rad startup)")
    save = block("teardown", "Persist Radius state (rad shutdown)")
    cleanup = block("teardown", "Cleanup control plane cluster")
    for index, exits in enumerate([
        (0, 0, 0, 0), (7, 0, 0, 0), (0, 9, 0, 0),
        (0, 0, 11, 0), (0, 9, 11, 17), (0, 0, 0, 17)
    ]):
        current = {**env, "ATTEMPT_ID": "attempt-" + str(index)}
        current.update(dict(zip(["RESTORE_EXIT", "COMMAND_EXIT", "SAVE_EXIT", "CLEANUP_EXIT"], map(str, exits))))
        pathlib.Path(current["CALLS"]).write_text("", encoding="utf-8")
        pathlib.Path(current["GITHUB_OUTPUT"]).write_text("", encoding="utf-8")
        initialized = execute(prefix + "lifecycle_initialize", current)
        assert initialized.returncode == 0, initialized.stderr
        current["RADIUS_LIFECYCLE_FILE"] = str(scratch / (".radius-lifecycle-operation-1-attempt-" + str(index)) / "lifecycle-result.json")
        restored = execute(startup, current)
        assert restored.returncode == exits[0], restored.stderr
        current["STATE_RESTORED"] = "true" if exits[0] == 0 else ""
        if exits[0] == 0:
            commanded = execute(prefix + "lifecycle_run commands rad deploy", current)
            assert commanded.returncode == exits[1]
        saved = execute(save, current)
        assert saved.returncode == (exits[2] if exits[0] == 0 else 0), saved.stderr
        cleaned = execute(cleanup, current)
        assert cleaned.returncode == exits[3], cleaned.stderr
        assert execute(prefix + "lifecycle_finalize", current).returncode == 0
        result = json.loads(pathlib.Path(current["RADIUS_LIFECYCLE_FILE"]).read_text())
        phases = result["phases"]
        if exits[0] != 0:
            assert "shutdown" not in pathlib.Path(current["CALLS"]).read_text()
            assert "deploy" not in pathlib.Path(current["CALLS"]).read_text()
            assert phases["stateSave"]["outcome"] == "skipped"
        else:
            assert "shutdown" in pathlib.Path(current["CALLS"]).read_text()
            assert phases["commands"]["exitCode"] == exits[1]
            assert phases["stateSave"]["exitCode"] == exits[2]
        assert phases["cleanup"]["exitCode"] == exits[3]
        if exits[1] != 0:
            assert result["primaryFailure"]["message"] == "commands failed."
        # Producer redaction accepts no raw command diagnostic text.
        assert execute(prefix + 'lifecycle_record commands failed 9 "password=fixture-sensitive-value"', current).returncode == 0
        assert "fixture-sensitive-value" not in pathlib.Path(current["RADIUS_LIFECYCLE_FILE"]).read_text()
    assert execute(prefix + "lifecycle_initialize", env).returncode != 0, "Existing evidence must never be reused"
    print("PASS lifecycle identity, checkout, restore guard, command/save/cleanup exits, redaction and finalization")
finally:
    shutil.rmtree(scratch)
PY
