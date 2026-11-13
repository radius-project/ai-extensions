import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(
  import.meta.dirname,
  "../../../.github/extension/actions/validate-deployment-identity/validate.mjs"
);

describe("executed generated-workflow identity preflight", () => {
  it.each([
    "literal",
    "mismatch",
    "dynamic",
    "override",
    "unknown",
    "outside",
    "delete",
    "invalid-delete"
  ] as const)("enforces the %s target before any cloud command", (kind) => {
    const workspace = mkdtempSync(join(tmpdir(), "radius-identity-"));
    try {
      writeFileSync(
        join(workspace, "app.bicep"),
        `resource app 'Radius.Core/applications@1' = {\n name: ${kind === "dynamic" ? "appName" : "'my-app'"}\n}`
      );
      const run = () =>
        execFileSync(process.execPath, [script], {
          env: {
            GITHUB_WORKSPACE: workspace,
            IDENTITY_KIND: kind.includes("delete") ? "delete" : "deploy",
            DECLARED_APPLICATION:
              kind === "unknown" ? "unknown"
              : kind === "mismatch" ? "other-app"
              : kind === "invalid-delete" ? "../other"
              : "my-app",
            MODEL_FILE: kind === "outside" ? "../outside.bicep" : "app.bicep",
            TARGET_ENVIRONMENT: "dev",
            RAD_COMMANDS:
              kind === "override" ?
                '["deploy other.bicep --environment dev"]'
              : ""
          },
          encoding: "utf8",
          stdio: "pipe"
        });
      if (["literal", "unknown", "delete"].includes(kind))
        expect(run()).toBe("");
      else expect(run).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
