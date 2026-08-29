import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliExec } from "./gh.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("cliExec POSIX process integration", () => {
  let directory = "";
  let originalPath: string | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "radius-gh-path-"));
    await writeFile(
      join(directory, "gh"),
      "#!/bin/sh\nprintf 'bundled-gh:%s' \"$1\"\n",
      { encoding: "utf8", mode: 0o755 }
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${directory}${delimiter}${originalPath || ""}`;
  });

  afterAll(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(["Path", "path"])(
    "resolves the inherited PATH when the caller supplies unrelated %s",
    async (key) => {
      const result = await new Promise<{
        error: Error | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        cliExec(
          "gh",
          ["probe"],
          { env: { [key]: "/caller-only" } },
          (error, stdout, stderr) => {
            resolve({ error, stdout, stderr });
          }
        );
      });

      expect(result).toEqual({
        error: null,
        stdout: "bundled-gh:probe",
        stderr: ""
      });
    }
  );
});
