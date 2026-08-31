import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAppTagPatchArgs } from "./azure-oidc.js";
import { cliExec } from "./gh.js";
import { displayGhCommand } from "./gh-command-display.js";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

interface CommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

describeWindows("cliExec Windows process integration", () => {
  let directory = "";
  let recorderPath = "";
  let launcherPath = "";
  let environment: NodeJS.ProcessEnv;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "radius cli "));
    recorderPath = join(directory, "record-args.cjs");
    launcherPath = join(directory, "az.cmd");

    await writeFile(
      recorderPath,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8"
    );
    await writeFile(
      launcherPath,
      [
        "@ECHO OFF",
        '@IF EXIST "%~dp0\\record-args.cjs" (',
        '  "%RADIUS_TEST_NODE%" "%~dp0\\record-args.cjs" %*',
        ") ELSE (",
        "  ECHO Argument recorder was not found. 1>&2",
        "  EXIT /B 91",
        ")",
        ""
      ].join("\r\n"),
      "utf8"
    );
    await writeFile(
      join(directory, "radius-fail.cmd"),
      ["@ECHO OFF", "ECHO fixture failure 1>&2", "EXIT /B 7", ""].join("\r\n"),
      "utf8"
    );
    // Installed only as a batch shim, exactly like AWS CLI v1 from pip. A bare
    // name for this tool is unresolvable by CreateProcess, so it exercises the
    // cmd.exe fallback rather than the direct launch.
    await writeFile(
      join(directory, "radius-batch-only.cmd"),
      [
        "@ECHO OFF",
        '"%RADIUS_TEST_NODE%" "%~dp0\\record-args.cjs" %*',
        ""
      ].join("\r\n"),
      "utf8"
    );

    // A tool installed only as a native executable, exactly like the AWS CLI v2
    // MSI and kubectl. A bare name for it must resolve through PATHEXT and then
    // launch directly, without cmd.exe touching its arguments.
    await copyFile(process.execPath, join(directory, "radius-native.exe"));

    environment = { ...process.env };
    const pathKey =
      Object.keys(environment).find((key) => key.toLowerCase() === "path") ||
      "PATH";
    environment[pathKey] = `${directory};${environment[pathKey] || ""}`;
    environment.RADIUS_TEST_NODE = process.execPath;
    environment.RADIUS_TEST_SENTINEL = "expanded-by-cmd";
  });

  afterAll(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the plain PATH-resolved Azure CLI batch command working", async () => {
    const result = await runCli("az", ["version", "-o", "json"]);

    expect(result).toEqual({
      code: 0,
      stdout: '["version","-o","json"]',
      stderr: ""
    });
  });

  it("round-trips the production App Registration tag PATCH arguments", async () => {
    const args = buildAppTagPatchArgs({
      appId: "11111111-2222-3333-4444-555555555555",
      tags: ["radius-managed", "radius-repo:octo/app"]
    });

    const result = await runCli(launcherPath, args);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("preserves metacharacters, embedded quotes, empty values, and trailing backslashes", async () => {
    const args = [
      "",
      "two words",
      'say "hello"',
      "C:\\temp\\",
      "applications(appId='fixture')",
      "left&right",
      "left|right",
      "left^right"
    ];

    const result = await runCli(launcherPath, args);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("runs a batch executable whose absolute path contains spaces", async () => {
    const args = ["version", "-o", "json"];

    const result = await runCli(launcherPath, args);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("runs a native executable directly without cmd.exe expansion", async () => {
    const result = await runCli(process.execPath, [
      recorderPath,
      "%RADIUS_TEST_SENTINEL%"
    ]);

    expect(result).toEqual({
      code: 0,
      stdout: '["%RADIUS_TEST_SENTINEL%"]',
      stderr: ""
    });
  });

  // The only case here that starts Windows PowerShell. Every sibling spawns
  // cmd.exe or node and finishes in milliseconds, while this interpreter costs
  // seconds to boot, and CI runs its jobs under pwsh 7 so 5.1 starts cold.
  // execFile also leaves the child's stdin pipe open, and PowerShell consumes a
  // redirected stdin until an EOF that never arrives, so refuse stdin outright
  // and close the pipe the way runCli already does for every other case. The
  // wider budget then covers the cold interpreter start that the shared 15s
  // default left no margin for.
  it("runs the displayed PowerShell invocation for an absolute path", async () => {
    const command = displayGhCommand(
      {
        kind: "absolute",
        shell: "powershell",
        executablePath: launcherPath,
        installationNote: ""
      },
      ["version", "two words"]
    );
    const result = await new Promise<CommandResult>((resolve) => {
      const child = execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-InputFormat",
          "None",
          "-Command",
          command
        ],
        { env: environment, windowsHide: true },
        (error, stdout, stderr) => {
          resolve({
            code: error?.code || 0,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          });
        }
      );
      child.stdin?.end();
    });

    expect(result).toEqual({
      code: 0,
      stdout: '["version","two words"]',
      stderr: ""
    });
  }, 30_000);

  it("preserves a batch command failure and stderr", async () => {
    const result = await runCli("radius-fail.cmd", ["ignored"]);

    expect(result.code).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fixture failure");
  });

  it("resolves a bare name installed only as a batch shim", async () => {
    const result = await runCli("radius-batch-only", ["eks", "list-clusters"]);

    expect(result).toEqual({
      code: 0,
      stdout: '["eks","list-clusters"]',
      stderr: ""
    });
  });

  // The production callers pass bare `aws` and `kubectl`, so PATHEXT resolution
  // and the direct launch have to hold for a name rather than an absolute path.
  it("resolves a bare name installed as a native executable without cmd.exe expansion", async () => {
    const result = await runCli("radius-native", [
      recorderPath,
      "%RADIUS_TEST_SENTINEL%",
      'say "hello"',
      "applications(appId='fixture')"
    ]);

    expect(result).toEqual({
      code: 0,
      stdout: JSON.stringify([
        "%RADIUS_TEST_SENTINEL%",
        'say "hello"',
        "applications(appId='fixture')"
      ]),
      stderr: ""
    });
  });

  // cmd.exe searches the working directory before PATH, and the CLI children
  // inherit the open repository. An absent tool must therefore fail rather than
  // run a same-named batch file that the repository happened to carry.
  it("never runs a batch file that exists only in the working directory", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "radius cwd "));
    try {
      await writeFile(
        join(workingDirectory, "radius-planted-tool.cmd"),
        ["@ECHO OFF", "ECHO planted-payload-ran", ""].join("\r\n"),
        "utf8"
      );
      // Windows consults the working directory only while this policy variable
      // is absent, which is the default. Drop it so the test is not vacuous on
      // a machine that happens to set it.
      const workingEnvironment = { ...environment };
      for (const key of Object.keys(workingEnvironment)) {
        if (key.toLowerCase() === "nodefaultcurrentdirectoryinexepath") {
          delete workingEnvironment[key];
        }
      }

      const result = await runCli("radius-planted-tool", ["version"], {
        cwd: workingDirectory,
        env: workingEnvironment
      });

      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("planted-payload-ran");
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it("reports a failure for a command installed in no form at all", async () => {
    const result = await runCli("radius-absent-tool", ["version"]);

    expect(result.code).not.toBe(0);
  });

  function runCli(
    command: string,
    args: string[],
    overrides: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = cliExec(
        command,
        args,
        { env: environment, ...overrides },
        (error, stdout, stderr) => {
          resolve({
            code: error?.code || 0,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          });
        }
      );
      child.stdin?.end();
    });
  }
});
