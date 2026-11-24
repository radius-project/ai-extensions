import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const script = resolve(
  import.meta.dirname,
  "../../../.github/extension/actions/validate-deployment-identity/validate.mjs"
);

describe("approved deployment guard", () => {
  const guard = pathToFileURL(
    resolve(dirname(script), "approved-deployment.mjs")
  ).href;
  const statuses = (run: number, state = "success") => [
    { state, log_url: `https://github.com/octo/app/actions/runs/${run}/job/5` }
  ];

  it("suppresses routing deployment records only for guarded dispatch", () => {
    const workflow = parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../.github/extension/delete-application.yml"
        ),
        "utf8"
      )
    );
    expect(workflow.jobs.detect.environment).toEqual({
      name: "${{ inputs.environment || '{{ENV}}' }}",
      deployment: "${{ inputs.approved_deployment_id == '' }}"
    });
  });

  it.each([
    {
      case: "own run is skipped",
      rows: [{ id: 3 }, { id: 2 }],
      current: statuses(19),
      approved: statuses(17),
      ok: true
    },
    {
      case: "replacement",
      rows: [{ id: 3 }, { id: 2 }],
      current: statuses(18),
      approved: statuses(17),
      ok: false
    },
    {
      case: "newer record from a noncanonical workflow",
      rows: [{ id: 3 }, { id: 2 }],
      current: statuses(16),
      approved: statuses(17),
      ok: false
    },
    {
      case: "first record has a lower ID than the approved record",
      rows: [{ id: 1 }, { id: 2 }],
      current: statuses(16),
      approved: statuses(17),
      ok: false
    },
    {
      case: "unidentified first record",
      rows: [{}, { id: 2 }],
      current: [],
      approved: statuses(17),
      ok: false
    },
    {
      case: "newer record with the same run ID",
      rows: [{ id: 3 }, { id: 2 }],
      current: statuses(17),
      approved: statuses(17),
      ok: false
    },
    {
      case: "unknown newer deployment",
      rows: [{ id: 3 }, { id: 2 }],
      current: [],
      approved: statuses(17),
      ok: false
    },
    {
      case: "different run on same deployment",
      rows: [{ id: 2 }],
      current: [],
      approved: statuses(179),
      ok: false
    },
    {
      case: "approved run became active",
      rows: [{ id: 2 }],
      current: [],
      approved: statuses(17, "in_progress"),
      ok: false
    },
    {
      case: "approved deployment became inactive even when the new record is ours",
      rows: [{ id: 3 }, { id: 2 }],
      current: statuses(19),
      approved: statuses(17, "inactive"),
      ok: false
    },
    {
      case: "deployment missing",
      rows: [],
      current: [],
      approved: [],
      ok: false
    }
  ])(
    "enforces the exact approval under the workflow lock: $case",
    ({ rows, current, approved, ok }) => {
      const env = {
        GITHUB_REPOSITORY: "octo/app",
        GITHUB_RUN_ID: "19",
        TARGET_ENVIRONMENT: "dev",
        APPROVED_DEPLOYMENT_ID: "2",
        APPROVED_RUN_ID: "17"
      };
      const fixtures = {
        "/repos/octo/app/deployments?environment=dev&per_page=10": rows,
        "/repos/octo/app/deployments/1/statuses?per_page=1": current,
        "/repos/octo/app/deployments/3/statuses?per_page=1": current,
        "/repos/octo/app/deployments/2/statuses?per_page=1": approved
      };
      const code = `
      import { verifyApprovedDeployment } from ${JSON.stringify(guard)};
      const fixtures = ${JSON.stringify(fixtures)};
      await verifyApprovedDeployment(${JSON.stringify(env)}, (path) => {
        if (!Object.hasOwn(fixtures, path)) throw new Error("Unexpected request: " + path);
        return fixtures[path];
      });
    `;
      const run = () =>
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", code],
          {
            env: {},
            encoding: "utf8",
            stdio: "pipe"
          }
        );
      if (ok) expect(run()).toBe("");
      else
        expect(run).toThrow(
          "The approved deployment could not be verified as current."
        );
    }
  );
});

describe("executed generated-workflow identity preflight", () => {
  it.each([
    "literal",
    "mismatch",
    "dynamic",
    "multiline-example",
    "multiline-unknown",
    "override",
    "unknown",
    "outside",
    "delete",
    "invalid-delete"
  ] as const)("enforces the %s target before any cloud command", (kind) => {
    const workspace = mkdtempSync(join(tmpdir(), "radius-identity-"));
    try {
      const model = `resource app 'Radius.Core/applications@1' = {\n name: ${kind === "dynamic" ? "appName" : "'my-app'"}\n}`;
      writeFileSync(
        join(workspace, "app.bicep"),
        kind.startsWith("multiline-") ?
          `metadata example = '''
it's an example
${model}
'''
${model.replace("'my-app'", "'other-app'")}
metadata tail = '''
it's a tail
'''
`
        : model
      );
      const run = () =>
        execFileSync(process.execPath, [script], {
          env: {
            GITHUB_WORKSPACE: workspace,
            IDENTITY_KIND: kind.includes("delete") ? "delete" : "deploy",
            DECLARED_APPLICATION:
              kind === "unknown" || kind === "multiline-unknown" ? "unknown"
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
      if (["literal", "unknown", "multiline-unknown", "delete"].includes(kind))
        expect(run()).toBe("");
      else expect(run).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
