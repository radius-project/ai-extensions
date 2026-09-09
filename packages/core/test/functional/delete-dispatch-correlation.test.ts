// Functional: the correlation contract between the canvas and the committed
// delete dispatchers.
//
// The canvas dispatches every delete with `-f correlation_id=<id>` and then
// accepts ONLY the run whose display name carries that id — a delete of another
// environment, started at the same moment, must never be reported as this one's
// run. Both halves of that contract live in different repos' working copies at
// runtime (the canvas code here, the workflow file in the user's repository),
// and the templates in `.github/extension/` are what the extension commits, so
// this is where the two are pinned together.
//
// A dispatcher that declared no `correlation_id` input would make GitHub reject
// the dispatch outright (`Unexpected inputs provided`), and one that accepted
// the input without echoing it into `run-name:` would make discovery silently
// resolve nothing. Both are artifact-level facts about a committed YAML file,
// so they are asserted against the file rather than through a unit seam.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_RESOURCE_DISPATCHER_FILE
} from "../../src/index.js";

const EXTENSION_DIR = fileURLToPath(
  new URL("../../../../.github/extension/", import.meta.url)
);

// The exact input name the canvas dispatches with. Spelled out rather than
// imported so a rename on either side fails this test instead of moving
// silently in lockstep with it.
const CORRELATION_INPUT = "correlation_id";

interface DispatcherDocument {
  "run-name"?: unknown;
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
}

async function readDispatcher(file: string): Promise<DispatcherDocument> {
  return parseYaml(
    await readFile(`${EXTENSION_DIR}${file}`, "utf8")
  ) as DispatcherDocument;
}

describe("delete dispatchers carry the canvas's correlation id", () => {
  it.each([
    DELETE_APP_DISPATCHER_FILE,
    DELETE_RESOURCE_DISPATCHER_FILE,
    DELETE_ENV_DISPATCHER_FILE
  ])("%s declares the input and echoes it in its run name", async (file) => {
    const document = await readDispatcher(file);
    const inputs = document.on?.workflow_dispatch?.inputs ?? {};

    // Declared, and optional: a dispatch from an older canvas that sends no
    // correlation id must still start the delete.
    expect(Object.keys(inputs)).toContain(CORRELATION_INPUT);
    const input = inputs[CORRELATION_INPUT] as { required?: unknown };
    expect(input.required).not.toBe(true);
    // Echoed, which is the only thing that makes the run identifiable from
    // `gh run list --json displayTitle`.
    expect(String(document["run-name"] ?? "")).toContain(
      `\${{ inputs.${CORRELATION_INPUT} }}`
    );
  });
});
