// Scheduled workflows whose failures the Radius on-call triages label their
// failure issue `test-failure`, which is how on-call finds them. An unlabeled
// alert still opens an issue, so a missing label fails silently: the issue
// exists but no one is looking for it.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.github/workflows"
);

const ON_CALL_WORKFLOWS = [
  "canvas-functional.yml",
  "canvas-reliability.yml"
] as const;

const ISSUE_CREATE = /gh issue create\b[^\n]*/g;
const TEST_FAILURE_LABEL = /--label[= ]"?test-failure"?(\s|$)/;

async function issueCreateCommands(file: string): Promise<readonly string[]> {
  const raw = await readFile(path.join(WORKFLOWS_DIRECTORY, file), "utf8");
  return [...raw.matchAll(ISSUE_CREATE)].map((match) => match[0]);
}

describe.each(ON_CALL_WORKFLOWS)("%s scheduled failure alert", (file) => {
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
