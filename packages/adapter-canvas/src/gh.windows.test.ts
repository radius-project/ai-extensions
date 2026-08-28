import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAppTagPatchArgs } from "./azure-oidc.js";
import { cliExec } from "./gh.js";

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

  it("preserves a batch command failure and stderr", async () => {
    const result = await runCli("radius-fail.cmd", ["ignored"]);

    expect(result.code).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fixture failure");
  });

  function runCli(command: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = cliExec(
        command,
        args,
        { env: environment },
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
