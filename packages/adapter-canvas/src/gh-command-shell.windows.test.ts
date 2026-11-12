import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { displayGhCommand, displayGhCommands } from "./gh-command-display.js";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("native PowerShell command guidance", () => {
  let root = "";
  let executable = "";
  let recorder = "";
  const values = [
    "",
    "two words",
    "tab\tvalue",
    "line\nvalue",
    "line\r\nvalue",
    '.["field name"]',
    '"',
    'a"b',
    "it's",
    "$HOME",
    "$(whoami)",
    "`whoami`",
    "; echo injected",
    "%PATH%",
    "&|<>",
    "trail\\",
    "two words\\",
    'a\\"b',
    'a\\\\"b',
    'a "b" c',
    "\\".repeat(1_000) + "x",
    "\\".repeat(1_000) + '"',
    "\\".repeat(1_000)
  ];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "radius user's native tools "));
    const bin = join(root, "bin");
    await mkdir(bin);
    executable = join(bin, "gh.exe");
    recorder = join(root, "record.cjs");
    // A native executable, not a cmd/bat trampoline: exercise real CRT argv.
    await copyFile(process.execPath, executable);
    await writeFile(
      recorder,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
    );
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["powershell.exe", "pwsh.exe"])(
    "round-trips literals without expansion through %s",
    async (shell) => {
      const presentation = {
        kind: "absolute",
        shell: "powershell",
        executablePath: executable,
        installationNote: ""
      } as const;
      const command = displayGhCommand(presentation, [recorder, ...values]);
      const result = await run(shell, command);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(values);
      const ordinary = [
        "two words",
        "trail\\",
        "it's",
        "$HOME",
        "a,b",
        "a=b",
        "@value",
        "user:repo",
        ",start",
        "=equals",
        "+plus",
        "-flag",
        "--"
      ];
      expect(
        JSON.parse(
          (
            await run(
              shell,
              displayGhCommand(presentation, [recorder, ...ordinary])
            )
          ).stdout
        )
      ).toEqual(ordinary);
      // The preference assignment must be scoped, not change later commands.
      const scoped = await run(
        shell,
        `$PSNativeCommandArgumentPassing = 'Standard'; ${command}; if ($PSNativeCommandArgumentPassing -ne 'Standard') { exit 91 }`
      );
      expect(scoped.code).toBe(0);
      expect(JSON.parse(scoped.stdout)).toEqual(values);
      const generic = displayGhCommands(presentation, [
        [executable, recorder, ...values]
      ]);
      expect(JSON.parse((await run(shell, generic)).stdout)).toEqual(values);
    },
    15_000
  );

  function run(shell: string, command: string) {
    return new Promise<{
      code: string | number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = execFile(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-InputFormat",
          "None",
          "-Command",
          command
        ],
        {
          windowsHide: true,
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            PATHEXT: process.env.PATHEXT,
            ComSpec: process.env.ComSpec,
            HOME: root,
            USERPROFILE: root,
            TEMP: root,
            TMP: root
          }
        },
        (error, stdout, stderr) =>
          resolve({
            code: error?.code ?? 0,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          })
      );
      child.stdin?.end();
    });
  }
});
