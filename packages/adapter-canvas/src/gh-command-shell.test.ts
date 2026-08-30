import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { displayGhCommand } from "./gh-command-display.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("GitHub CLI POSIX shell display integration", () => {
  let root = "";
  let executable = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "radius gh user's tools "));
    const bin = join(root, "copilot-desktop-gh-fixture");
    executable = join(bin, "gh");
    await mkdir(bin);
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
    const command = displayGhCommand(
      {
        kind: "absolute",
        shell: "posix",
        executablePath: executable,
        installationNote: ""
      },
      ["auth", "refresh", "two words"]
    );
    const shell = process.platform === "darwin" ? "zsh" : "bash";
    const result = await new Promise<{
      code: string | number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(shell, ["-c", command], (error, stdout, stderr) => {
        resolve({
          code: error?.code || 0,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      });
    });

    expect(result).toEqual({
      code: 0,
      stdout: '["auth","refresh","two words"]',
      stderr: ""
    });
  });
});
