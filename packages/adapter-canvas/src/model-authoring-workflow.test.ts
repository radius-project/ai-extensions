import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  MODEL_ONLY_MARKER,
  modelOnlyRestriction
} from "@radius-project/core/modeling";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const script = path.join(
  root,
  ".github/extension/actions/check-model-authoring/check.py"
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("workflow authoring guard", () => {
  it.each([
    ["ordinary model", undefined, true],
    ["ordinary model", "{}", true],
    [MODEL_ONLY_MARKER, undefined, false],
    ["edited model", '{"authoring":null}', false],
    ["edited model", "{malformed", false],
    ["edited model", "[]", false]
  ])(
    "enforces the same restriction as Canvas for %s / %s",
    (model, origin, allowed) => {
      const workspace = mkdtempSync(path.join(tmpdir(), "authoring-workflow-"));
      directories.push(workspace);
      mkdirSync(path.join(workspace, ".radius"));
      writeFileSync(path.join(workspace, ".radius/app.bicep"), model);
      if (origin !== undefined)
        writeFileSync(path.join(workspace, ".radius/app.origin.json"), origin);
      const result = spawnSync("python3", [script], {
        cwd: workspace,
        env: { PATH: process.env.PATH, RADIUS_APP_FILE: ".radius/app.bicep" },
        encoding: "utf8"
      });
      expect(result.error).toBeUndefined();
      expect(result.status === 0).toBe(allowed);
      expect(modelOnlyRestriction(model, origin) === null).toBe(allowed);
      if (!allowed) expect(result.stderr).toMatch(/unverified|provenance/);
    }
  );

  it.each(["../outside.bicep", "missing.bicep"])(
    "rejects an unconfined or absent checkout model: %s",
    (file) => {
      const workspace = mkdtempSync(path.join(tmpdir(), "authoring-workflow-"));
      directories.push(workspace);
      const result = spawnSync("python3", [script], {
        cwd: workspace,
        env: { PATH: process.env.PATH, RADIUS_APP_FILE: file },
        encoding: "utf8"
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/escapes|Cannot establish/);
    }
  );

  it.each(["azure", "aws"])(
    "gates the actual %s workflow checkout before login",
    (provider) => {
      const workflow = parse(
        readFileSync(
          path.join(root, `.github/extension/run-rad-commands-${provider}.yml`),
          "utf8"
        )
      );
      const steps = workflow.jobs.deploy.steps;
      expect(steps[0].uses).toMatch(/^actions\/checkout@/);
      expect(steps[1]).toEqual({
        name: "Check application authoring contract",
        uses: "radius-project/ai-extensions/.github/extension/actions/check-model-authoring@{{RADIUS_REF}}",
        with: { "app-file": "{{APP_FILE}}" }
      });
    }
  );
});
