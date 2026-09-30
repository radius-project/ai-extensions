// These scheduled workflows label their failure issue `test-failure` so the
// failures can be found by label. An unlabeled alert still opens an issue, so a
// missing label fails silently.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.github/workflows"
);

const LABELED_WORKFLOWS = [
  "canvas-functional.yml",
  "canvas-reliability.yml"
] as const;

const ISSUE_CREATE = /gh issue create\b[^\n]*/g;
const TEST_FAILURE_LABEL = /--label[= ]"?test-failure"?(\s|$)/;

async function issueCreateCommands(file: string): Promise<readonly string[]> {
  const raw = await readFile(path.join(WORKFLOWS_DIRECTORY, file), "utf8");
  return [...raw.matchAll(ISSUE_CREATE)].map((match) => match[0]);
}

describe.each(LABELED_WORKFLOWS)("%s scheduled failure alert", (file) => {
  it("opens an issue when a scheduled run fails", async () => {
    expect(await issueCreateCommands(file)).not.toHaveLength(0);
  });

  it("labels that issue test-failure", async () => {
    const unlabeled = (await issueCreateCommands(file)).filter(
      (command) => !TEST_FAILURE_LABEL.test(command)
    );
    expect(unlabeled).toEqual([]);
  });
});
