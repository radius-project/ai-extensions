import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnRad } from "../../adapter-shared/src/rad-process.mjs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("managed rad Windows process integration", () => {
  let directory = "";
  let fixturePath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "managed-rad-process-"));
    fixturePath = join(directory, "fixture.cjs");
    await writeFile(
      fixturePath,
      [
        'process.stdout.write("captured stdout");',
        'process.stderr.write("captured stderr");',
        ""
      ].join("\n"),
      "utf8"
    );
  });

  afterAll(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs a native executable with piped stdout and stderr", async () => {
    await expect(
      spawnRad(process.execPath, [fixturePath], {
        timeout: 5000,
        label: "rad fixture"
      })
    ).resolves.toEqual({
      stdout: "captured stdout",
      stderr: "captured stderr"
    });
  });
});
