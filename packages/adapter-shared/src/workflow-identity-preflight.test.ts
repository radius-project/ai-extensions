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
const base = "/repos/octo/app";
const runPath = `${base}/actions/runs/19`;
const jobsPath = `${runPath}/attempts/1/jobs?per_page=30`;
const statusPath = `${base}/deployments/2/statuses?per_page=1`;
const own = { id: 3, node_id: "fixture-own" };
const approved = { id: 2, node_id: "fixture-approved" };
const older = { id: 1, node_id: "fixture-older" };
const foreign = { id: 4, node_id: "fixture-foreign" };
const runInfo = {
  id: 19,
  run_attempt: 1,
  event: "workflow_dispatch",
  path: ".github/workflows/delete-application.yml",
  repository: { full_name: "octo/app" },
  node_id: "fixture-run"
};
const checkIds = ["fixture-check"];
const jobs = { total_count: 1, jobs: [{ node_id: checkIds[0] }] };
const link = (
  environment: string,
  id = own.node_id,
  run = runInfo.node_id
) => ({
  data: {
    nodes: [
      {
        id: checkIds[0],
        checkSuite: { workflowRun: { id: run } },
        deployment: { id, environment }
      }
    ]
  }
});

describe("approved deployment guard", () => {
  const guard = pathToFileURL(
    resolve(dirname(script), "approved-deployment.mjs")
  ).href;
  const statuses = (run: number, state = "success") => [
    { state, log_url: `https://github.com/octo/app/actions/runs/${run}/job/5` }
  ];

  it.each(["azure", "aws"])(
    "forwards the exact approval and token to %s inside the shared lock",
    (provider) => {
      const yaml = (file: string) =>
        parse(
          readFileSync(
            resolve(import.meta.dirname, "../../../.github/extension", file),
            "utf8"
          )
        );
      const dispatcher = yaml("delete-application.yml");
      const workflow = yaml(`delete-${provider}.yml`);
      const deploy = yaml(`run-rad-commands-${provider}.yml`);
      const action = yaml("actions/validate-deployment-identity/action.yml");
      expect(dispatcher.permissions.deployments).toBe("read");
      expect(dispatcher.permissions.checks).toBe("read");
      expect(workflow.permissions.deployments).toBe("read");
      expect(workflow.permissions.checks).toBe("read");
      expect(workflow.concurrency).toEqual(deploy.concurrency);
      const [job] = Object.values<{
        environment: unknown;
        steps: { uses?: string; with?: unknown }[];
      }>(workflow.jobs);
      expect(job.environment).toBe("${{ inputs.environment }}");
      expect(
        job.steps.find((step) =>
          step.uses?.includes("/validate-deployment-identity@")
        )?.with
      ).toMatchObject({
        "approved-deployment-id": "${{ inputs.approved_deployment_id }}",
        "approved-run-id": "${{ inputs.approved_run_id }}",
        "github-token": "${{ github.token }}"
      });
      expect(dispatcher.jobs[provider].with).toMatchObject({
        approved_deployment_id: "${{ inputs.approved_deployment_id }}",
        approved_run_id: "${{ inputs.approved_run_id }}"
      });
      expect(
        action.runs.steps.find((step: { env?: unknown }) => step.env).env
      ).toMatchObject({
        APPROVED_DEPLOYMENT_ID: "${{ inputs.approved-deployment-id }}",
        APPROVED_RUN_ID: "${{ inputs.approved-run-id }}",
        GH_TOKEN: "${{ inputs.github-token }}"
      });
    }
  );

  it("skips the environment-bound detector for guarded callers without removing provider protections", () => {
    const workflow = parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../.github/extension/delete-application.yml"
        ),
        "utf8"
      )
    );
    expect(workflow.jobs.detect.environment).toBe(
      "${{ inputs.environment || '{{ENV}}' }}"
    );
    expect(workflow.jobs.detect.if).toBe(
      "${{ inputs.approved_deployment_id == '' && inputs.approved_run_id == '' && inputs.approved_provider == '' }}"
    );
    for (const provider of ["azure", "aws"])
      expect(workflow.jobs[provider].if).toContain(
        `needs.detect.result == 'skipped' && inputs.approved_deployment_id != '' && inputs.approved_run_id != '' && inputs.approved_provider == '${provider}'`
      );
  });

  it.each([
    {
      case: "a foreign record claims this run in its writable URL",
      rows: [foreign, approved],
      approved: statuses(17),
      ok: false
    },
    {
      case: "only this job's own deployment precedes the approval",
      rows: [own, approved, older],
      approved: statuses(17),
      ok: true
    },
    {
      case: "a record is created while the approved status is read",
      rows: [own, approved, older],
      after: [foreign, own, approved, older],
      approved: statuses(17),
      ok: false
    },
    {
      case: "replacement",
      rows: [own, foreign, approved],
      approved: statuses(17),
      ok: false
    },
    {
      case: "the deployment link belongs to another run",
      rows: [own, approved],
      graph: link("dev", own.node_id, "fixture-other-run"),
      approved: statuses(17),
      ok: false
    },
    {
      case: "the provider deployment is not present",
      rows: [approved, older],
      approved: statuses(17),
      ok: false
    },
    {
      case: "unidentified first record",
      rows: [{ id: 3 }, approved],
      approved: statuses(17),
      ok: false
    },
    {
      case: "the deployment is linked to a different environment",
      rows: [own, approved],
      graph: link("other"),
      approved: statuses(17),
      ok: false
    },
    {
      case: "GitHub returns errors despite matching data",
      rows: [own, approved],
      graph: { ...link("dev"), errors: [{ message: "no access" }] },
      approved: statuses(17),
      ok: false
    },
    {
      case: "different run on same deployment",
      rows: [own, approved],
      approved: statuses(179),
      ok: false
    },
    {
      case: "approved run became active",
      rows: [own, approved],
      approved: statuses(17, "in_progress"),
      ok: false
    },
    {
      case: "approved deployment became inactive even when the new record is ours",
      rows: [own, approved],
      approved: statuses(17, "inactive"),
      ok: false
    },
    {
      case: "deployment missing",
      rows: [],
      approved: [],
      ok: false
    }
  ])(
    "enforces the exact approval under the workflow lock: $case",
    ({ rows, approved: status, after, graph, ok }) => {
      const env = {
        GITHUB_REPOSITORY: "octo/app",
        GITHUB_RUN_ID: "19",
        GITHUB_RUN_ATTEMPT: "1",
        TARGET_ENVIRONMENT: "dev",
        APPROVED_DEPLOYMENT_ID: "2",
        APPROVED_RUN_ID: "17"
      };
      const fixtures = {
        "/repos/octo/app/deployments?environment=dev&per_page=10": rows,
        [runPath]: runInfo,
        [jobsPath]: jobs,
        "/graphql": graph ?? link("dev"),
        [statusPath]: status
      };
      const code = `
      import { verifyApprovedDeployment } from ${JSON.stringify(guard)};
      import assert from "node:assert/strict";
      const fixtures = ${JSON.stringify(fixtures)};
      const after = ${JSON.stringify(after ?? null)};
      let historyReads = 0;
      await verifyApprovedDeployment(${JSON.stringify(env)}, (path, body) => {
        if (!Object.hasOwn(fixtures, path)) throw new Error("Unexpected request: " + path);
        if (path === "/graphql") assert.deepEqual(body.variables.ids, ${JSON.stringify(checkIds)});
        if (path.includes("/deployments?") && ++historyReads === 2 && after) return after;
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

describe("approved deployment validator transport", () => {
  it.each([
    "accepted",
    "missing token",
    "partial approval",
    "HTTP rejection",
    "redirect",
    "transport rejection"
  ])("validates the dispatched contract with %s", (scenario) => {
    const env = {
      IDENTITY_KIND: "delete",
      DECLARED_APPLICATION: "app",
      GITHUB_REPOSITORY: "octo/app",
      GITHUB_RUN_ID: "19",
      GITHUB_RUN_ATTEMPT: "1",
      TARGET_ENVIRONMENT: "qa/eu",
      APPROVED_DEPLOYMENT_ID: "2",
      APPROVED_RUN_ID: scenario === "partial approval" ? "" : "17",
      GH_TOKEN: scenario === "missing token" ? "" : "fixture",
      SCENARIO: scenario
    };
    const code = `
        import assert from "node:assert/strict";
        const history = "https://api.github.com/repos/octo/app/deployments?environment=qa%2Feu&per_page=10";
        const origin = "https://api.github.com";
        const fixtures = new Map([
          [history, ${JSON.stringify([own, approved])}],
          [origin + ${JSON.stringify(runPath)}, ${JSON.stringify(runInfo)}],
          [origin + ${JSON.stringify(jobsPath)}, ${JSON.stringify(jobs)}],
          [origin + "/graphql", ${JSON.stringify(link("qa/eu"))}],
          [origin + ${JSON.stringify(statusPath)}, [{state: "success", log_url: "https://github.com/octo/app/actions/runs/17"}]]
        ]);
        const expected = [...fixtures.keys(), history];
        const calls = [];
        globalThis.fetch = async (url, options) => {
          calls.push(url);
          const isGraph = url === origin + "/graphql";
          assert.deepEqual(options.headers, {authorization: "Bearer fixture", accept: "application/vnd.github+json", ...(isGraph ? {"content-type": "application/json"} : {})});
          if (isGraph) {
            assert.equal(options.method, "POST");
            assert.deepEqual(JSON.parse(options.body).variables, {ids: ${JSON.stringify(checkIds)}});
          } else {
            assert.equal(options.method, undefined);
            assert.equal(options.body, undefined);
          }
          assert.equal(options.redirect, "error");
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(url, expected[calls.length - 1]);
          if (process.env.SCENARIO === "HTTP rejection") return new Response(null, {status: 403});
          if (process.env.SCENARIO === "redirect") throw new TypeError("redirect rejected");
          if (process.env.SCENARIO === "transport rejection") throw new TypeError("connection refused");
          return Response.json(fixtures.get(url));
        };
        const load = () => import(${JSON.stringify(pathToFileURL(script).href)});
        const errors = {
          "missing token": /Deployment records are unavailable/,
          "partial approval": /approved deployment could not be verified/,
          "HTTP rejection": /Could not read deployment records/,
          "redirect": /redirect rejected/,
          "transport rejection": /connection refused/
        };
        if (process.env.SCENARIO === "accepted") {
          await load();
          assert.deepEqual(calls, expected);
        } else {
          await assert.rejects(load, errors[process.env.SCENARIO]);
          assert.equal(calls.length, ["missing token", "partial approval"].includes(process.env.SCENARIO) ? 0 : 1);
        }
      `;
    expect(
      execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
        env,
        encoding: "utf8"
      })
    ).toBe("");
  });
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
