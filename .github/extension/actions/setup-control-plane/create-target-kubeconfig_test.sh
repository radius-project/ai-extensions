#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

python3 - "${SCRIPT_DIR}" <<'PYTHON'
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

source = pathlib.Path(sys.argv[1])
action = (source / "action.yml").read_text(encoding="utf-8")
step = re.search(
    r"    - name: Create target-kubeconfig secret\n"
    r"(?:(?!    - name:).*\n)*?      run: \|\n"
    r"((?:        .*\n|\n)+)",
    action,
)
assert step, "Missing create-secret action step"
script = "\n".join(line[8:] for line in step[1].splitlines()) + "\n"
assert script.startswith('timeout 5m bash '), "Missing hard preparation bound"
subprocess.run(
    ["shellcheck", "--shell=bash", "-"], input=script, text=True, check=True
)

unavailable = (
    'error: error validating "STDIN": error validating data: '
    "failed to download openapi: the server is currently unable to handle the request"
)
cases = [
    ("ready", [], [], 0, 1, 1, []),
    ("namespace delayed", [unavailable], [], 0, 2, 1, [1]),
    ("secret delayed", [], [unavailable], 0, 1, 2, [1]),
    ("both delayed", [unavailable] * 2, [unavailable], 0, 3, 2, [1, 2, 1]),
    ("last namespace attempt", [unavailable] * 4, [], 0, 5, 1, [1, 2, 4, 8]),
    ("last secret attempt", [], [unavailable] * 4, 0, 1, 5, [1, 2, 4, 8]),
    ("namespace exhausted", [unavailable] * 5, [], 9, 5, 0, [1, 2, 4, 8]),
    ("secret exhausted", [], [unavailable] * 5, 9, 1, 5, [1, 2, 4, 8]),
    ("namespace becomes forbidden", [unavailable, "Forbidden"], [], 9, 2, 0, [1]),
    ("secret becomes forbidden", [], [unavailable, "Forbidden"], 9, 1, 2, [1]),
]
for error in [
    "Error from server (Forbidden): namespaces is forbidden",
    "error: You must be logged in to the server (Unauthorized)",
    "error: error validating STDIN: unknown field",
    "error: failed to download openapi: x509: certificate signed by unknown authority",
    "error: failed to download openapi: connection refused",
    "Error from server (ServiceUnavailable): the server is currently unable to handle the request",
    "",
]:
    cases.extend([
        ("namespace permanent " + error, [error], [], 9, 1, 0, []),
        ("secret permanent " + error, [], [error], 9, 1, 1, []),
    ])

with tempfile.TemporaryDirectory(prefix="target-kubeconfig-test-") as directory:
    root = pathlib.Path(directory)
    binary = root / "bin"
    binary.mkdir()
    (binary / "kubectl").write_text(
        """#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["CASE_ROOT"])
args = sys.argv[1:]
assert args.pop(0) == "--request-timeout=10s", args
if args[0] == "create":
    assert args[-3:] == ["--dry-run=client", "-o", "yaml"], args
    if args[1] == "namespace":
        assert args[1:-3] == ["namespace", "radius-system"], args
        resource = "namespace"
    else:
        assert args[1:-3] == [
            "secret", "generic", "target-kubeconfig",
            "--namespace", "radius-system",
            "--from-file=kubeconfig=" + os.environ["RADIUS_TARGET_KUBECONFIG"]
        ], args
        resource = "secret"
    counter = root / (resource + ".generated")
    counter.write_text(str(int(counter.read_text()) + 1 if counter.exists() else 1))
    if os.environ.get("FAIL_GENERATE") == resource:
        print("synthetic generation failure", file=sys.stderr)
        sys.exit(7)
    print(resource)
elif args == ["apply", "-f", "-"]:
    resource = sys.stdin.read().strip()
    if resource not in ("namespace", "secret"):
        print("missing manifest", file=sys.stderr)
        sys.exit(8)
    counter = root / (resource + ".count")
    index = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(index + 1))
    failures = json.loads(os.environ["FAILURES"])[resource]
    if index < len(failures):
        print(failures[index], file=sys.stderr)
        sys.exit(9)
    print(resource + " prepared")
else:
    raise AssertionError(args)
""",
        encoding="utf-8",
    )
    (binary / "sleep").write_text(
        '#!/bin/sh\nprintf "%s\\n" "$1" >>"$CASE_ROOT/sleeps"\n',
        encoding="utf-8",
    )
    for stub in binary.iterdir():
        stub.chmod(0o755)
    kubeconfig = root / "target config"
    kubeconfig.write_text("synthetic target", encoding="utf-8")
    for index, (name, namespaces, secrets, code, ns_count, secret_count, sleeps) in enumerate(cases):
        case = root / str(index)
        case.mkdir()
        env = {
            **os.environ,
            "PATH": str(binary) + os.pathsep + os.environ["PATH"],
            "CASE_ROOT": str(case),
            "FAILURES": json.dumps({"namespace": namespaces, "secret": secrets}),
            "GITHUB_ACTION_PATH": str(source),
            "RADIUS_TARGET_KUBECONFIG": str(kubeconfig),
        }
        result = subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", script],
            env=env, text=True, capture_output=True, timeout=10,
        )
        assert result.returncode == code, (name, result)
        assert "synthetic target" not in result.stdout + result.stderr, result
        for resource, expected in [("namespace", ns_count), ("secret", secret_count)]:
            path = case / (resource + ".count")
            actual = int(path.read_text()) if path.exists() else 0
            assert actual == expected, (name, resource, actual, expected, result)
            generated = case / (resource + ".generated")
            assert (int(generated.read_text()) if generated.exists() else 0) == min(expected, 1)
        sleep_file = case / "sleeps"
        actual_sleeps = [int(x) for x in sleep_file.read_text().splitlines()] if sleep_file.exists() else []
        assert actual_sleeps == sleeps, (name, actual_sleeps, sleeps)
        if code:
            assert namespaces[-1:] == [""] or secrets[-1:] == [""] or (
                namespaces + secrets
            )[-1] in result.stderr, (name, result.stderr)
        if "exhausted" in name:
            assert "remained unavailable after 5 attempts" in result.stderr

    for resource in ("namespace", "secret"):
        env["FAILURES"] = '{"namespace":[],"secret":[]}'
        env["FAIL_GENERATE"] = resource
        result = subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", script],
            env=env, text=True, capture_output=True, timeout=10,
        )
        assert result.returncode == 7, (resource, result)
        assert "synthetic generation failure" in result.stderr, result
        assert "retrying preparation" not in result.stderr, result
    env.pop("FAIL_GENERATE")
    before_skip = {p.name: p.read_bytes() for p in case.iterdir()}
    for target in (str(root / "absent"), "", None):
        if target is None:
            env.pop("RADIUS_TARGET_KUBECONFIG")
        else:
            env["RADIUS_TARGET_KUBECONFIG"] = target
        result = subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", script],
            env=env, text=True, capture_output=True, timeout=10,
        )
        assert result.returncode == 0 and "No target kubeconfig" in result.stdout, result
        assert {p.name: p.read_bytes() for p in case.iterdir()} == before_skip

print(f"Target kubeconfig preparation passed {len(cases) + 5} cases")
PYTHON
