#!/bin/bash

# Behavioral tests for the teardown action's state-persistence guard and the
# application-status listing, plus the restore-state output they depend on.
# The actual `run:` blocks are extracted from the composite action YAML and
# executed with stubbed `rad`/`git` on PATH -- no cluster or rad CLI required.
#
# Invariants covered:
#   1. restore-state sets `state-restored=true` on $GITHUB_OUTPUT after
#      `rad startup` succeeds, and creates the `default` group AFTER startup.
#   2. First run: `rad startup` is a no-op restore that still exits 0, so the
#      output is still set (teardown then seeds the archive).
#   3. Negative path: when `rad startup` fails, the block exits non-zero and
#      never sets `state-restored`, so teardown will skip persistence.
#   4. teardown runs `rad shutdown` only when state-restored == "true".
#   5. teardown skips `rad shutdown` (with a ::warning::) when it is not "true"
#      (a run that failed before startup must not overwrite the state archive).
#   6. teardown lists applications via the Radius.Core preview API surface
#      (`rad app list --preview`), and surfaces a warning if that listing fails
#      instead of swallowing it silently.
#   7. Every workflow that uses the teardown action (discovered dynamically)
#      wires state-restored from a restore-state step (id: restore-state) in the
#      SAME job, uses both actions together, and the check is proven to reject
#      broken wiring (missing id, missing output pass-through, cross-job split).

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
import os
import collections
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

repo_root = pathlib.Path(sys.argv[1])
ext_root = repo_root / ".github/extension"
restore_action = ext_root / "actions/restore-state/action.yml"
teardown_action = ext_root / "actions/teardown/action.yml"

# Discover the workflow files dynamically instead of hardcoding, so a newly
# added workflow that uses the teardown action is covered automatically.
teardown_use = re.compile(r"actions/teardown@")
restore_use = re.compile(r"actions/restore-state@")
all_workflows = sorted(p for p in ext_root.glob("*.yml"))
teardown_workflows = [p for p in all_workflows if teardown_use.search(p.read_text(encoding="utf-8"))]
restore_workflows = [p for p in all_workflows if restore_use.search(p.read_text(encoding="utf-8"))]

failures = []

# Single scratch root cleaned up on exit, so no per-case temp dirs leak.
scratch_root = pathlib.Path(tempfile.mkdtemp(prefix="teardown-test-"))


def fail(message):
    failures.append(message)


def extract_run_block(action_file, step_name):
    """Return the shell body of the `run: |` block for a named step."""
    lines = action_file.read_text(encoding="utf-8").splitlines()

    name_pattern = re.compile(r"^\s*-\s*name:\s*" + re.escape(step_name) + r"\s*$")
    name_idx = next((i for i, line in enumerate(lines) if name_pattern.match(line)), None)
    if name_idx is None:
        sys.exit(f"{action_file}: step '{step_name}' not found")

    run_pattern = re.compile(r"^\s*run:\s*\|\s*$")
    run_idx = next(
        (i for i in range(name_idx + 1, len(lines)) if run_pattern.match(lines[i])),
        None,
    )
    if run_idx is None:
        sys.exit(f"{action_file}: step '{step_name}' has no 'run: |' block")

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
        sys.exit(f"{action_file}: step '{step_name}' run block is empty")

    return "\n".join(body).rstrip("\n") + "\n"


_case_counter = [0]

# Named fields rather than a positional tuple: the retry cases need the sleep
# log and the diagnostic directory alongside the existing three signals.
RunResult = collections.namedtuple(
    "RunResult", "stdout stderr rad output sleeps state_save_dir"
)


def run_block(script, env_extra=None, rad_fail_on="", capture_output=False,
              expect_failure=False, rad_fail_times=""):
    """Execute a run block with stubbed rad/git/sleep.

    rad_fail_on: substring of the joined rad args that makes the stub exit 1
    (used to simulate `rad startup` or `rad app list` failing).
    rad_fail_times: when set, the stub only fails that many invocations before
    succeeding, which is how the shutdown retry's recovery path is driven.
    Returns a RunResult with the process output, the rad invocation log, the
    $GITHUB_OUTPUT contents, the sleep log, and the state-save diagnostic dir.
    """
    _case_counter[0] += 1
    workdir = scratch_root / f"case-{_case_counter[0]}"
    bin_dir = workdir / "bin"
    bin_dir.mkdir(parents=True)
    rad_log = workdir / "rad.log"
    sleep_log = workdir / "sleep.log"
    github_output = workdir / "github_output"
    github_output.write_text("", encoding="utf-8")

    (bin_dir / "rad").write_text(
        "#!/bin/bash\n"
        'printf \'%s\\n\' "$*" >> "${RAD_LOG}"\n'
        'if [ -n "${RAD_FAIL_ON}" ] && [[ "$*" == *"${RAD_FAIL_ON}"* ]]; then\n'
        '  if [ -n "${RAD_FAIL_TIMES}" ]; then\n'
        '    COUNT=$(grep -c . "${RAD_LOG}")\n'
        '    if [ "$COUNT" -gt "${RAD_FAIL_TIMES}" ]; then exit 0; fi\n'
        "  fi\n"
        '  echo "rad: state archive unreachable" >&2\n'
        "  exit 1\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    # Stub git so `git config --global` cannot mutate the real environment, and
    # sleep so the bounded retry backoff does not make this suite wait for real.
    (bin_dir / "git").write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
    (bin_dir / "sleep").write_text(
        "#!/bin/bash\nprintf 'sleep %s\\n' \"$*\" >> \"${SLEEP_LOG}\"\nexit 0\n",
        encoding="utf-8",
    )
    for stub in ("rad", "git", "sleep"):
        (bin_dir / stub).chmod(0o755)

    script_path = workdir / "block.sh"
    script_path.write_text(script, encoding="utf-8")

    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["RAD_LOG"] = str(rad_log)
    env["SLEEP_LOG"] = str(sleep_log)
    env["GITHUB_OUTPUT"] = str(github_output)
    env["RAD_FAIL_ON"] = rad_fail_on
    env["RAD_FAIL_TIMES"] = str(rad_fail_times)
    env["RUNNER_TEMP"] = str(workdir / "runner-temp")
    # The run identity GitHub exports. The state-save diagnostic is scoped to the
    # run ATTEMPT, so it has to be readable from the block under test.
    env.setdefault("GITHUB_RUN_ID", "4242")
    env.setdefault("GITHUB_RUN_ATTEMPT", "1")
    (workdir / "runner-temp").mkdir()
    if env_extra:
        env.update(env_extra)

    # GitHub runs composite bash `run:` blocks with `set -eo pipefail`.
    result = subprocess.run(
        ["bash", "-eo", "pipefail", str(script_path)],
        capture_output=True,
        text=True,
        env=env,
    )
    if expect_failure and result.returncode == 0:
        fail("expected run block to fail but it exited 0")
    if not expect_failure and result.returncode != 0:
        fail(
            f"run block exited {result.returncode}: "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    invocations = rad_log.read_text(encoding="utf-8") if rad_log.exists() else ""
    output = github_output.read_text(encoding="utf-8")
    sleeps = sleep_log.read_text(encoding="utf-8") if sleep_log.exists() else ""
    return RunResult(
        result.stdout, result.stderr, invocations, output, sleeps,
        pathlib.Path(env["RUNNER_TEMP"]) / "radius-state-save"
    )


def job_at_line(lines, target_idx):
    """Return the job name that owns the line at target_idx, or None."""
    job = None
    in_jobs = False
    for line in lines[: target_idx + 1]:
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
            continue
        if in_jobs and re.match(r"^\S", line):
            in_jobs = False
        if in_jobs:
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
            if m:
                job = m.group(1)
    return job


restore_block = extract_run_block(restore_action, "Restore Radius state (rad startup)")
persist_block = extract_run_block(teardown_action, "Persist Radius state (rad shutdown)")
status_block = extract_run_block(teardown_action, "Show application status")

# 1. restore-state: on success, sets the output and creates the group after startup.
restore = run_block(restore_block)
restore_rad, restore_out = restore.rad, restore.output
if "startup" not in restore_rad:
    fail("restore-state block must call `rad startup`")
if "state-restored=true" not in restore_out:
    fail("restore-state must write `state-restored=true` to $GITHUB_OUTPUT after startup")
# Group create/switch must come AFTER `rad startup` in the invocation log.
rad_calls = [c for c in restore_rad.splitlines() if c.strip()]
startup_idx = next((i for i, c in enumerate(rad_calls) if c.startswith("startup")), None)
group_idx = next((i for i, c in enumerate(rad_calls) if c.startswith("group create")), None)
if startup_idx is None or group_idx is None:
    fail("restore-state must call both `rad startup` and `rad group create default`")
elif group_idx < startup_idx:
    fail("restore-state must create the `default` group AFTER `rad startup`, not before")

# 2. First run: `rad startup` no-op still exits 0, so the output is still set.
#    (The stub models the no-op restore by succeeding without side effects.)
if "state-restored=true" not in run_block(restore_block).output:
    fail("first-run no-op `rad startup` must still set `state-restored=true`")

# 3. Negative path: `rad startup` failing stops the block (set -e) before the
#    echo, so the output is never set and teardown will skip persistence.
failed_out = run_block(
    restore_block, rad_fail_on="startup", expect_failure=True
).output
if "state-restored=true" in failed_out:
    fail("restore-state must NOT set `state-restored` when `rad startup` fails")

# 4. teardown persists when state-restored == "true".
persist_true = run_block(persist_block, env_extra={"STATE_RESTORED": "true"})
if "shutdown" not in persist_true.rad:
    fail("teardown must run `rad shutdown` when state-restored is true")
if "state-save-failed=false" not in persist_true.output:
    fail("teardown must report a successful state save through `state-save-failed=false`")
if persist_true.state_save_dir.joinpath("state-save-failure.json").exists():
    fail("teardown must not publish a state-save diagnostic when the save succeeded")
if persist_true.sleeps:
    fail("teardown must not back off when the first `rad shutdown` succeeds")

# 5. teardown skips (with a warning) when state-restored is not "true".
for value in ("", "false"):
    skipped = run_block(persist_block, env_extra={"STATE_RESTORED": value})
    if "shutdown" in skipped.rad:
        fail(f"teardown must NOT run `rad shutdown` when state-restored='{value}'")
    if "::warning" not in skipped.stdout:
        fail(f"teardown must emit a ::warning:: when skipping persistence (value='{value}')")

# 5a. Exception 5.4: a transient `rad shutdown` failure is retried with a bounded
#     backoff, and a later success saves the state with no diagnostic published.
recovered = run_block(
    persist_block,
    env_extra={"STATE_RESTORED": "true"},
    rad_fail_on="shutdown",
    rad_fail_times=1,
)
shutdown_attempts = [c for c in recovered.rad.splitlines() if c.strip() == "shutdown"]
if len(shutdown_attempts) != 2:
    fail(
        "teardown must retry `rad shutdown` after a transient failure "
        f"(attempts={len(shutdown_attempts)})"
    )
if "sleep 5" not in recovered.sleeps:
    fail("teardown must back off before the second `rad shutdown` attempt")
if recovered.state_save_dir.joinpath("state-save-failure.json").exists():
    fail("teardown must not publish a diagnostic when a retry saved the state")
if "state-save-failed=false" not in recovered.output:
    fail("a recovered state save must report `state-save-failed=false`")

# 5b. Exhausted retries: the step still exits 0 (the deploy/delete itself ran),
#     warns with the orphan recovery path, and publishes the diagnostic artifact
#     the canvas reads.
exhausted = run_block(
    persist_block, env_extra={"STATE_RESTORED": "true"}, rad_fail_on="shutdown"
)
shutdown_attempts = [c for c in exhausted.rad.splitlines() if c.strip() == "shutdown"]
if len(shutdown_attempts) != 3:
    fail(
        "teardown must make exactly three bounded `rad shutdown` attempts "
        f"(attempts={len(shutdown_attempts)})"
    )
if exhausted.sleeps.count("sleep") != 2:
    fail("teardown must back off exactly once between each of the three attempts")
if "sleep 5" not in exhausted.sleeps or "sleep 15" not in exhausted.sleeps:
    fail("teardown must use an increasing bounded backoff between attempts")
if "::error title=Radius state was not saved::" not in exhausted.stdout:
    fail("teardown must surface an error annotation when state was never saved")
for phrase in (
    "Orphaned cloud resources may exist.",
    "redeploy the application",
    "delete the deployment and redeploy it",
):
    if phrase not in exhausted.stdout:
        fail(f"teardown's state-save error must name the recovery path: '{phrase}'")
if "state-save-failed=true" not in exhausted.output:
    fail("teardown must gate the diagnostic upload on `state-save-failed=true`")
diagnostic = exhausted.state_save_dir / "state-save-failure.json"
if not diagnostic.exists():
    fail("teardown must publish state-save-failure.json when every attempt failed")
else:
    payload = json.loads(diagnostic.read_text(encoding="utf-8"))
    if payload.get("outcome") != "state_save_failed":
        fail("the state-save diagnostic must declare outcome=state_save_failed")
    if payload.get("attempts") != 3:
        fail("the state-save diagnostic must record the number of attempts made")
    if "state archive unreachable" not in payload.get("error", ""):
        fail("the state-save diagnostic must carry the rad shutdown output")
    if payload.get("runAttempt") != "1":
        fail("the state-save diagnostic must record the GitHub run attempt it came from")
    if payload.get("runId") != "4242":
        fail("the state-save diagnostic must record the GitHub run id it came from")
if "state-save-artifact=radius-state-save-failure-attempt-1" not in exhausted.output:
    fail("teardown must name the diagnostic artifact for its own run attempt")

# 5b-ii. A rerun of the SAME run id publishes under a different artifact name and
#        payload attempt, so attempt 1's failure can never be read as attempt 2's.
rerun = run_block(
    persist_block,
    env_extra={"STATE_RESTORED": "true", "GITHUB_RUN_ATTEMPT": "2"},
    rad_fail_on="shutdown",
)
if "state-save-artifact=radius-state-save-failure-attempt-2" not in rerun.output:
    fail("a rerun must publish its diagnostic under its own attempt-scoped artifact name")
rerun_payload = json.loads(
    (rerun.state_save_dir / "state-save-failure.json").read_text(encoding="utf-8")
)
if rerun_payload.get("runAttempt") != "2":
    fail("a rerun's diagnostic must record run attempt 2")

# 5c. The artifact name and file name are a contract with the canvas reader.
teardown_yaml = teardown_action.read_text(encoding="utf-8")
if "name: ${{ steps.persist-state.outputs.state-save-artifact }}" not in teardown_yaml:
    fail("teardown must upload the diagnostic under the attempt-scoped artifact name")
if "radius-state-save-failure-attempt-" not in teardown_yaml:
    fail("teardown must build the artifact name from the run attempt")
canvas_reader = (repo_root / "packages/adapter-canvas/src/state-save-diagnostics.ts").read_text(
    encoding="utf-8"
)
for literal in ('"radius-state-save-failure"', '"state-save-failure.json"'):
    if literal not in canvas_reader:
        fail(f"the canvas state-save reader must keep the {literal} contract")
if "-attempt-" not in canvas_reader:
    fail("the canvas state-save reader must resolve the attempt-scoped artifact name")

# 6. Status listing uses the preview surface and warns (does not swallow) on failure.
status_rad = run_block(status_block).rad
if "app list --preview" not in status_rad:
    fail("teardown status step must run `rad app list --preview`")
if re.search(r"(?m)^app list\s*$", status_rad):
    fail("teardown status step must not use the legacy `rad app list` (no --preview)")
status_fail_stdout = run_block(status_block, rad_fail_on="app list").stdout
if "::warning" not in status_fail_stdout:
    fail("teardown status step must warn (not swallow) when `rad app list --preview` fails")

# 7. Every workflow using the teardown action wires state-restored from a
#    same-job restore-state step. Checked against every workflow discovered
#    dynamically, with negative cases proving the check rejects broken wiring.
restore_id = re.compile(r"^\s*id:\s*restore-state\s*$")
wiring = re.compile(r"state-restored:\s*\$\{\{\s*steps\.restore-state\.outputs\.state-restored\s*\}\}")


def wiring_problems(lines):
    """Return a list of wiring problems for a workflow's lines (empty == OK)."""
    problems = []
    teardown_idx = next((i for i, l in enumerate(lines) if teardown_use.search(l)), None)
    if teardown_idx is None:
        return problems  # workflow doesn't use teardown; nothing to wire
    id_idx = next((i for i, l in enumerate(lines) if restore_id.match(l)), None)
    wire_idx = next((i for i, l in enumerate(lines) if wiring.search(l)), None)
    if id_idx is None:
        problems.append("uses teardown but has no `id: restore-state` step")
        return problems
    if wire_idx is None:
        problems.append("teardown is not passed the state-restored output")
        return problems
    teardown_job = job_at_line(lines, teardown_idx)
    restore_job = job_at_line(lines, id_idx)
    if teardown_job is None or teardown_job != restore_job:
        problems.append(
            f"restore-state ({restore_job}) and teardown ({teardown_job}) are not in the same job"
        )
    return problems


# Coverage guard: there must be workflows to check, and any workflow that uses
# the teardown action must also use the restore-state action (and vice versa),
# so a new caller cannot land wired to one but not the other.
if not teardown_workflows:
    fail("no workflow uses the teardown action; expected the deploy/delete workflows to")
if set(teardown_workflows) != set(restore_workflows):
    only_teardown = sorted(p.name for p in set(teardown_workflows) - set(restore_workflows))
    only_restore = sorted(p.name for p in set(restore_workflows) - set(teardown_workflows))
    fail(
        "teardown and restore-state must be used by the same workflows; "
        f"teardown-only={only_teardown}, restore-only={only_restore}"
    )

for wf in teardown_workflows:
    lines = wf.read_text(encoding="utf-8").splitlines()

    # Positive: the real workflow wires it correctly.
    for problem in wiring_problems(lines):
        fail(f"{wf.name}: {problem}")

    # Negative cases: each mutation of the real workflow must be rejected.
    without_id = [l for l in lines if not restore_id.match(l)]
    if not wiring_problems(without_id):
        fail(f"{wf.name}: check must reject a workflow missing `id: restore-state`")

    without_wire = [l for l in lines if not wiring.search(l)]
    if not wiring_problems(without_wire):
        fail(f"{wf.name}: check must reject a workflow that does not pass the state-restored output")

    # Split restore-state and teardown into different jobs by inserting a new
    # job header immediately before the teardown step.
    teardown_idx = next((i for i, l in enumerate(lines) if teardown_use.search(l)), None)
    # Walk back to the `- name:` line that starts the teardown step.
    step_start = teardown_idx
    while step_start > 0 and not re.match(r"^\s*-\s*name:", lines[step_start]):
        step_start -= 1
    split = lines[:step_start] + ["  injected-other-job:", "    runs-on: ubuntu-latest", "    steps:"] + lines[step_start:]
    if not wiring_problems(split):
        fail(f"{wf.name}: check must reject restore-state and teardown living in different jobs")

shutil.rmtree(scratch_root, ignore_errors=True)

if failures:
    for message in failures:
        sys.stderr.write(f"FAIL: {message}\n")
    sys.exit(1)

print("teardown state-persistence, status, and workflow-wiring tests passed")
PYTHON
