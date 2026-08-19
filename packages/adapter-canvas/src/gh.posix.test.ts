import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliExec } from "./gh.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

interface CommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

describePosix("cliExec POSIX process integration", () => {
  let directory = "";
  let environment: NodeJS.ProcessEnv;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "radius cli "));
    const recorder = join(directory, "record-args.mjs");
    await writeFile(
      recorder,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8"
    );
    for (const command of ["gh", "radius-argv"]) {
      const launcher = join(directory, command);
      await writeFile(
        launcher,
        `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
        "utf8"
      );
      await chmod(launcher, 0o755);
    }

    environment = {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH || ""}`
    };
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("executes fake GitHub authentication commands without a shell", async () => {
    const result = await runCli("gh", ["auth", "status"]);

    expect(result).toEqual({
      code: 0,
      stdout: '["auth","status"]',
      stderr: ""
    });
  });

  it("preserves macOS and Linux paths, spaces, quotes, and empty arguments", async () => {
    const args = [
      "/Users/fixture user/worktrees/radius/app.bicep",
      "/home/fixture user/worktrees/radius/app.bicep",
      'say "hello"',
      ""
    ];

    const result = await runCli("radius-argv", args);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(args);
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
