// Every scheduled workflow that files an issue on failure labels it
// `test-failure`, which is how the Radius on-call finds failures to triage.
// An unlabeled alert still opens an issue, so a missing label fails silently:
// the issue exists but no one is looking for it.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.github/workflows"
);

const ISSUE_CREATE = /gh issue create\b[^\n]*/g;

async function issueCreateCommands(): Promise<
  readonly { readonly file: string; readonly command: string }[]
> {
  const files = (await readdir(WORKFLOWS_DIRECTORY)).filter((file) =>
    /\.ya?ml$/.test(file)
  );
  const commands: { file: string; command: string }[] = [];
  for (const file of files.sort()) {
    const raw = await readFile(path.join(WORKFLOWS_DIRECTORY, file), "utf8");
    for (const match of raw.matchAll(ISSUE_CREATE)) {
      commands.push({ file, command: match[0] });
    }
  }
  return commands;
}

describe("scheduled failure alerts", () => {
  it("covers every workflow that alerts on a scheduled failure", async () => {
    const files = new Set((await issueCreateCommands()).map((c) => c.file));
    expect([...files]).toEqual(
      expect.arrayContaining([
        "canvas-functional.yml",
        "canvas-reliability.yml",
        "cloud-e2e-cleanup.yml",
        "cloud-e2e.yml"
      ])
    );
  });

  it("labels every alert issue test-failure", async () => {
    const unlabeled = (await issueCreateCommands()).filter(
      ({ command }) => !/--label[= ]"?test-failure"?(\s|$)/.test(command)
    );
    expect(unlabeled).toEqual([]);
  });
});
