#!/bin/bash

# Execute the workflow's listing and guard steps without cloud access.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

for tool in python3 jq shellcheck; do
    command -v "${tool}" >/dev/null 2>&1 || {
        echo "FAIL: ${tool} is required" >&2
        exit 1
    }
done

python3 - "${SCRIPT_DIR}/../../delete-environment-azure.yml" <<'PYTHON'
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

lines = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()


def extract_step(name):
    matches = [
        i for i, line in enumerate(lines)
        if re.fullmatch(r"\s*-\s+name:\s+" + re.escape(name), line)
    ]
    assert len(matches) == 1, f"expected one step named {name}"
    start = matches[0]
    step_indent = len(lines[start]) - len(lines[start].lstrip())
    run_at = None
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line.strip() and len(line) - len(line.lstrip()) <= step_indent:
            break
        if re.fullmatch(r"\s*run:\s*\|", line):
            run_at = i
            break
    assert run_at is not None, f"no run block for {name}"
    body = []
    indent = None
    for line in lines[run_at + 1:]:
        if not line.strip():
            body.append("")
            continue
        current = len(line) - len(line.lstrip())
        if indent is None:
            indent = current
        if current < indent:
            break
        body.append(line[indent:])
    assert any(body), f"empty run block for {name}"
    return "\n".join(body) + "\n"


listing = extract_step("List applications in the environment")
guard = extract_step("Guard - environment has no deployed applications")
for script in (listing, guard):
    subprocess.run(
        ["shellcheck", "--shell=bash", "-"], input=script, text=True, check=True
    )

cases = [
    ("empty array", "[]", 0, 0, ""),
    ("empty list from Radius 0.62", "null", 0, 0, ""),
    ("null with whitespace", " \nnull\t\n", 0, 0, ""),
    ("one application", '[{"name":"web"}]', 0, 1, "web"),
    ("two applications", '[{"name":"web"},{"name":"worker"}]', 0, 2, "web,worker"),
    ("empty output", "", 0, None, None),
    ("whitespace only", " \t\n", 0, None, None),
    ("malformed JSON", "[", 0, None, None),
    ("object", '{"value":[]}', 0, None, None),
    ("string", '"null"', 0, None, None),
    ("false", "false", 0, None, None),
    ("true", "true", 0, None, None),
    ("number", "0", 0, None, None),
    ("two arrays", "[]\n[]", 0, None, None),
    ("null then array", 'null\n[{"name":"web"}]', 0, None, None),
    ("array then null", "[]\nnull", 0, None, None),
    ("array then malformed JSON", "[]\n{", 0, None, None),
    ("failed read with null", "null", 7, None, None),
    ("failed read with empty array", "[]", 7, None, None),
    ("failed read without output", "", 7, None, None),
    ("name with newline", json.dumps([{"name": "web\napp_count=0"}]),
     0, 1, "web,app_count=0"),
    ("name with shell syntax", json.dumps([{"name": "$(touch unexpected)"}]),
     0, 1, "$(touch unexpected)"),
]

with tempfile.TemporaryDirectory(prefix="delete-env-test-") as directory:
    root = pathlib.Path(directory)
    bin_dir = root / "bin"
    bin_dir.mkdir()
    rad = bin_dir / "rad"
    rad.write_text(
        '#!/bin/bash\nset -euo pipefail\n'
        '[[ "$*" == "application list --output json" ]] || exit 99\n'
        'printf "%s" "$RAD_OUTPUT"\n'
        'if [[ "$RAD_EXIT" != 0 ]]; then echo "synthetic read failure" >&2; fi\n'
        'exit "$RAD_EXIT"\n',
        encoding="utf-8",
    )
    rad.chmod(0o755)
    output = root / "github-output"
    for name, response, exit_code, count, names in cases:
        output.write_text("", encoding="utf-8")
        env = {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "RESOURCE_NAME": "test-environment",
            "GITHUB_OUTPUT": str(output),
            "RAD_OUTPUT": response,
            "RAD_EXIT": str(exit_code),
        }
        result = subprocess.run(
            ["bash", "-eo", "pipefail", "-s"], input=listing, env=env,
            cwd=root, capture_output=True, text=True, timeout=10,
        )
        contents = output.read_text(encoding="utf-8")
        if count is None:
            assert result.returncode != 0, f"{name}: listing unexpectedly passed"
            assert contents == "", f"{name}: failure published guard inputs"
            assert "::error::" in result.stdout, f"{name}: missing diagnostic"
            if exit_code:
                assert "synthetic read failure" in result.stderr, name
        else:
            assert result.returncode == 0, f"{name}: {result.stdout}{result.stderr}"
            expected_count = f"app_count={count}\n"
            assert contents.startswith(expected_count), f"{name}: {contents}"
            header, remainder = contents[len(expected_count):].split("\n", 1)
            assert header.startswith("app_names<<"), f"{name}: {contents}"
            delimiter = header.removeprefix("app_names<<")
            assert remainder == f"{names}\n{delimiter}\n", f"{name}: {contents}"
            checked = subprocess.run(
                ["bash", "-eo", "pipefail", "-s"], input=guard,
                env={**env, "APP_COUNT": str(count), "APP_NAMES": names},
                cwd=root, capture_output=True, text=True, timeout=10,
            )
            assert (checked.returncode == 0) == (count == 0), (
                f"{name}: wrong guard result: {checked.stdout}{checked.stderr}"
            )
            if count:
                assert "::error::" in checked.stdout, name
                assert names in checked.stdout, name
        assert not (root / "unexpected").exists(), f"{name}: executed app name"
        print(f"PASS: {name}")

print(f"Environment-delete listing and guard tests passed ({len(cases)} cases).")
PYTHON
