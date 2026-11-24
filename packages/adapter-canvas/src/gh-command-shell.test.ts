import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { displayGhCommand, displayGhCommands } from "./gh-command-display.js";

describe("GitHub CLI POSIX shell display integration", () => {
  let root = "";
  let executable = "";
  let prefix: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "radius gh user's tools "));
    const bin = join(root, "copilot-desktop-gh-fixture");
    await mkdir(bin);
    if (process.platform === "win32") {
      executable = join(bin, "gh.exe");
      await copyFile(process.execPath, executable);
      const recorder = join(root, "record.cjs");
      await writeFile(
        recorder,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
      );
      prefix = [recorder.replaceAll("\\", "/")];
      executable = executable.replaceAll("\\", "/");
      return;
    }
    executable = join(bin, "gh");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8"
    );
    await chmod(executable, 0o700);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("runs the displayed invocation in the supported host shell", async () => {
    const args = [
      "auth",
      "refresh",
      "",
      "two words",
      "tab\tvalue",
      "line\nvalue",
      '.["field name"]',
      "it's",
      "$HOME",
      "`whoami`",
      "; echo injected",
      "%PATH%",
      "&|<>",
      "back\\slash"
    ];
    const command = displayGhCommand(
      {
        kind: "absolute",
        shell: "posix",
        executablePath: executable,
        installationNote: ""
      },
      [...prefix, ...args]
    );
    const shell = process.platform === "darwin" ? "zsh" : "bash";
    const invoke = (command: string) =>
      new Promise<{
        code: string | number;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        const child = execFile(
          shell,
          ["-c", command],
          {
            timeout: 5000,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
              PATHEXT: process.env.PATHEXT,
              ComSpec: process.env.ComSpec,
              HOME: root,
              TMP: root,
              TEMP: root,
              MSYS2_ARG_CONV_EXCL: "*"
            }
          },
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
    expect(await invoke(command)).toEqual({
      code: 0,
      stdout: JSON.stringify(args),
      stderr: ""
    });
    expect(
      await invoke(
        displayGhCommands(
          { kind: "bare", shell: "posix", installationNote: "" },
          [[executable, ...prefix, ...args]]
        )
      )
    ).toEqual({ code: 0, stdout: JSON.stringify(args), stderr: "" });
  });
});
